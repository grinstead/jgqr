function getGeneratorIndex(data) {
  return data & 0xf;
}

function getAdditionalByteCount(data) {
  return data >> 11;
}

function getNumBlocks(data) {
  return (data >> 4) & 0x7f;
}

function galoisMultiplication(rawA, rawB) {
  let product = 0;
  let a = rawA;
  let b = rawB;

  while (a && b) {
    if (b & 1) product ^= a;
    b >>= 1;
    a <<= 1;
    if (a & 0x100) a ^= 0x11d;
  }

  return product;
}

function makeGeneratorData() {
  const expos = [1];
  while (expos.length < 255) {
    expos.push(galoisMultiplication(expos[expos.length - 1], 2));
  }

  const polynomials = RAW_GENERATOR_DATA.split("\n").filter(Boolean);
  return polynomials.map((poly) => {
    const terms = poly.split("+");
    const numBytes = parseInt(terms.shift().substring(1), 10);

    const coefficientsMap = new Map();
    terms.forEach((term) => {
      const match = /^(a\d*)?(x\d*)?$/.exec(term);
      if (!match) {
        console.error(poly);
      } else {
        const [, alpha, power] = match;
        const coefficient = alpha
          ? expos[parseInt(alpha.substring(1) || "1", 10)]
          : 1;
        const position = power ? power.substring(1) || "1" : "0";
        coefficientsMap.set(position, coefficient);
      }
    });

    const coefficients = [];
    for (let i = numBytes - 1; i >= 0; i--) {
      coefficients.push(coefficientsMap.get(i.toString(10)) || 0);
    }

    return coefficients.map((x) => `00${x.toString(16)}`.slice(-2)).join("");
  });
}

function makeErrorCorrectionData() {
  // simplify the format
  const cleaned = RAW_ERROR_CORRECTION_TABLES.replace(/[\s\n]+/g, " ");
  const lines = cleaned.split(" ");

  const readInt = (couldExceed1000) => {
    let value = 0;
    do {
      const term = lines.shift();
      value = 1000 * value + parseInt(term, 10);
      if (value !== value) {
        throw new Error(`Bad int ${JSON.stringify(term)}`);
      }
    } while (couldExceed1000 && /\d{3}/.test(lines[0]));
    return value;
  };

  const readExact = (exact) => {
    const term = lines.shift();
    if (term !== exact) {
      throw new Error(`${JSON.stringify(term)} !== ${JSON.stringify(exact)}`);
    }
    return exact;
  };

  const readQuality = (quality) => {
    const level = readExact(quality);
    const numErrorCorrectionBytes = readInt(true);
    const blockCounts = [];
    do {
      blockCounts.push(readInt(false));
    } while (/^\d+$/.test(lines[0]));

    const blockData = blockCounts.map((numBlocks) => {
      const tuple = /^\((\d+),(\d+),(\d+)\)/.exec(lines.shift());
      const [, numTotalBytesStr, numDataBytesStr, redundancy] = tuple;

      const numTotalBytes = parseInt(numTotalBytesStr, 10);
      const numDataBytes = parseInt(numDataBytesStr, 10);

      return {
        numBlocks,
        totalBytesPerBlock: numTotalBytes,
        dataBytesPerBlock: numDataBytes,
      };
    });

    // I think the data is already sorted, but may as well
    blockData.sort((a, b) => a.numTotalBytes - b.numTotalBytes);

    return { level, numErrorCorrectionBytes, blockData };
  };

  const rows = [];
  while (lines.length) {
    const version = readInt(false);
    const totalBytes = readInt(true);
    const L = readQuality("L");
    const M = readQuality("M");
    const Q = readQuality("Q");
    const H = readQuality("H");
    rows.push({ version, totalBytes, L, M, Q, H });
  }

  return rows;
}

function generateDataFile() {
  let allGenerators = makeGeneratorData();
  const rows = makeErrorCorrectionData();

  // for some reason, the spec provides excess generators
  const allErrorCorrectionCounts = new Set(
    rows
      .map((row) =>
        [row.L, row.M, row.H, row.Q].map(
          ({ blockData }) =>
            blockData[0].totalBytesPerBlock - blockData[0].dataBytesPerBlock
        )
      )
      .flat()
  );
  const generators = Array.from(
    new Set(
      allGenerators.filter((x) => allErrorCorrectionCounts.has(x.length / 2))
    )
  );

  const computeArray = (quality) => {
    let priorByteCount = 0;
    return rows
      .map((row) => {
        const blockData = row[quality].blockData;

        const numEncodableBytes =
          row.totalBytes - row[quality].numErrorCorrectionBytes;
        const numErrorCorrectionPerBlock =
          blockData[0].totalBytesPerBlock - blockData[0].dataBytesPerBlock;
        const numBlocks = blockData.reduce(
          (acc, { numBlocks }) => acc + numBlocks,
          0
        );

        const generatorIndex = generators.findIndex(
          (gen) => gen.length === numErrorCorrectionPerBlock * 2
        );
        if (generatorIndex === -1) throw Error();

        const additionalByteCount = numEncodableBytes - priorByteCount;

        const union =
          (additionalByteCount << 11) | (numBlocks << 4) | generatorIndex;

        const base32 = `0000${union.toString(32)}`.slice(-4);

        // sanity check
        if (
          base32.length !== 4 ||
          additionalByteCount !== getAdditionalByteCount(union) ||
          numBlocks !== getNumBlocks(union) ||
          generatorIndex !== getGeneratorIndex(union)
        ) {
          throw Error("bad encoding");
        }

        priorByteCount = numEncodableBytes;

        return base32;
      })
      .join("");
  };

  const BLOCK_DATA = [
    computeArray("M"),
    computeArray("L"),
    computeArray("H"),
    computeArray("Q"),
  ];

  return `// \x40autogenerated

export ${getGeneratorIndex}

export ${getAdditionalByteCount}

export ${getNumBlocks}

/** the generator coefficients, encoded in hex and separated by "|" */
export const GENERATOR_DATA =
  ${JSON.stringify(generators.join("|"))};

/**
 * Packed 32-bit data structures representing the qr code data info
 * for each error-correction level, sorted M L H Q (the bit-order)
 */
export const BLOCK_DATA =
  ${JSON.stringify(BLOCK_DATA.join("|"))};`;
}

/**
 * These values are all the generator polynomials that were in the spec.
 * The format here is what happens when you ctrl-c from the pdf, so the exponent tags are missing.
 * x7 means x^7 and a251 means alpha^251 (alpha being the primitive element, which in our case is 2).
 *
 * We boil this down into something smaller for the actual code, but I wanted to show where the
 * data came from here.
 */
const RAW_GENERATOR_DATA = `
x7+a87x6+a229x5+a146x4+a149x3+a238x2+a102x+a21
x10+a251x9+a67x8+a46x7+a61x6+a118x5+a70x4+a64x3+a94x2+a32x+a45
x13+a74x12+a152x11+a176x10+a100x9+a86x8+a100x7+a106x6+a104x5+a130x4+a218x3+a206x2+a140x+a78
x15+a8x14+a183x13+a61x12+a91x11+a202x10+a37x9+a51x8+a58x7+a58x6+a237x5+a140x4+a124x3+a5x2+a99x+a105
x16+a120x15+a104x14+a107x13+a109x12+a102x11+a161x10+a76x9+a3x8+a91x7+a191x6+a147x5+a169x4+a182x3+a194x2+a225x+a120
x17+a43x16+a139x15+a206x14+a78x13+a43x12+a239x11+a123x10+a206x9+a214x8+a147x7+a24x6+a99x5+a150x4+a39x3+a243x2+a163x+a136
x18+a215x17+a234x16+a158x15+a94x14+a184x13+a97x12+a118x11+a170x10+a79x9+a187x8+a152x7+a148x6+a252x5+a179x4+a5x3+a98x2+a96x+a153
x20+a17x19+a60x18+a79x17+a50x16+a61x15+a163x14+a26x13+a187x12+a202x11+a180x10+a221x9+a225x8+a83x7+a239x6+a156x5+a164x4+a212x3+a212x2+a188x+a190
x22+a210x21+a171x20+a247x19+a242x18+a93x17+a230x16+a14x15+a109x14+a221x13+a53x12+a200x11+a74x10+a8x9+a172x8+a98x7+a80x6+a219x5+a134x4+a160x3+a105x2+a165x+a231
x24+a229x23+a121x22+a135x21+a48x20+a211x19+a117x18+a251x17+a126x16+a159x15+a180x14+a169x13+a152x12+a192x11+a226x10+a228x9+a218x8+a111x7+x6+a117x5+a232x4+a87x3+a96x2+a227x+a21
x26+a173x25+a125x24+a158x23+a2x22+a103x21+a182x20+a118x19+a17x18+a145x17+a201x16+a111x15+a28x14+a165x13+a53x12+a161x11+a21x10+a245x9+a142x8+a13x7+a102x6+a48x5+a227x4+a153x3+a145x2+a218x+a70
x28+a168x27+a223x26+a200x25+a104x24+a224x23+a234x22+a108x21+a180x20+a110x19+a190x18+a195x17+a147x16+a205x15+a27x14+a232x13+a201x12+a21x11+a43x10+a245x9+a87x8+a42x7+a195x6+a212x5+a119x4+a242x3+a37x2+a9x+a123
x30+a41x29+a173x28+a145x27+a152x26+a216x25+a31x24+a179x23+a182x22+a50x21+a48x20+a110x19+a86x18+a239x17+a96x16+a222x15+a125x14+a42x13+a173x12+a226x11+a193x10+a224x9+a130x8+a156x7+a37x6+a251x5+a216x4+a238x3+a40x2+a192x+a180
x32a10x31+a6x30+a106x29+a190x28+a249x27+a167x26+a4x25+a67x24+a209x23+a138x22+a138x21+a32x20+a242x19+a123x18+a89x17+a27x16+a120x15+a185x14+a80x13+a156x12+a38x11+a69x10+a171x9+a60x8+a28x7+a222x6+a80x5+a52x4+a254x3+a185x2+a220x+a241
x34+a111x33+a77x32+a146x31+a94x30+a26x29+a21x28+a108x27+a19x26+a105x25+a94x24+a113x23+a193x22+a86x21+a140x20+a163x19+a125x18+a58x17+a158x16+a229x15+a239x14+a218x13+a103x12+a56x11+a70x10+a114x9+a61x8+a183x7+a129x6+a167x5+a13x4+a98x3+a62x2+a129x+a51
x36+a200x35+a183x34+a98x33+a16x32+a172x31+a31x30+a246x29+a234x28+a60x27+a152x26+a115x25+x24+a167x23+a152x22+a113x21+a248x20+a238x19+a107x18+a18x17+a63x16+a218x15+a37x14+a87x13+a210x12+a105x11+a177x10+a120x9+a74x8+a121x7+a196x6+a117x5+a251x4+a113x3+a233x2+a30x+a120
x40+a59x39+a116x38+a79x37+a161x36+a252x35+a98x34+a128x33+a205x32+a128x31+a161x30+a247x29+a57x28+a163x27+a56x26+a235x25+a106x24+a53x23+a26x22+a187x21+a174x20+a226x19+a104x18+a170x17+a7x16+a175x15+a35x14+a181x13+a114x12+a88x11+a41x10+a47x9+a163x8+a125x7+a134x6+a72x5+a20x4+a232x3+a53x2+a35x+a15
x42+a250x41+a103x40+a221x39+a230x38+a25x37+a18x36+a137x35+a231x34+x33+a3x32+a58x31+a242x30+a221x29+a191x28+a110x27+a84x26+a230x25+a8x24+a188x23+a106x22+a96x21+a147x20+a15x19+a131x18+a139x17+a34x16+a101x15+a223x14+a39x13+a101x12+a213x11+a199x10+a237x9+a254x8+a201x7+a123x6+a171x5+a162x4+a194x3+a117x2+a50x+a96
x44+a190x43+a7x42+a61x41+a121x40+a71x39+a246x38+a69x37+a55x36+a168x35+a188x34+a89x33+a243x32+a191x31+a25x30+a72x29+a123x28+a9x27+a145x26+a14x25+a247x24+ax23+a238x22+a44x21+a78x20+a143x19+a62x18+a224x17+a126x16+a118x15+a114x14+a68x13+a163x12+a52x11+a194x10+a217x9+a147x8+a204x7+a169x6+a37x5+a130x4+a113x3+a102x2+a73x+a181
x46+a112x45+a94x44+a88x43+a112x42+a253x41+a224x40+a202x39+a115x38+a187x37+a99x36+a89x35+a5x34+a54x33+a113x32+a129x31+a44x30+a58x29+a16x28+a135x27+a216x26+a169x25+a211x24+a36x23+ax22+a4x21+a96x20+a60x19+a241x18+a73x17+a104x16+a234x15+a8x14+a249x13+a245x12+a119x11+a174x10+a52x9+a25x8+a157x7+a224x6+a43x5+a202x4+a223x3+a19x2+a82x+a15
x48+a228x47+a25x46+a196x45+a130x44+a211x43+a146x42+a60x41+a24x40+a251x39+a90x38+a39x37+a102x36+a240x35+a61x34+a178x33+a63x32+a46x31+a123x30+a115x29+a18x28+a221x27+a111x26+a135x25+a160x24+a182x23+a205x22+a107x21+a206x20+a95x19+a150x18+a120x17+a184x16+a91x15+a21x14+a247x13+a156x12+a140x11+a238x10+a191x9+a11x8+a94x7+a227x6+a84x5+a50x4+a163x3+a39x2+a34x+a108
x50+a232x49+a125x48+a157x47+a161x46+a164x45+a9x44+a118x43+a46x42+a209x41+a99x40+a203x39+a193x38+a35x37+a3x36+a209x35+a111x34+a195x33+a242x32+a203x31+a225x30+a46x29+a13x28+a32x27+a160x26+a126x25+a209x24+a130x23+a160x22+a242x21+a215x20+a242x19+a75x18+a77x17+a42x16+a189x15+a32x14+a113x13+a65x12+a124x11+a69x10+a228x9+a114x8+a235x7+a175x6+a124x5+a170x4+a215x3+a232x2+a133x+a205
x52+a116x51+a50x50+a86x49+a186x48+a50x47+a220x46+a251x45+a89x44+a192x43+a46x42+a86x41+a127x40+a124x39+a19x38+a184x37+a233x36+a151x35+a215x34+a22x33+a14x32+a59x31+a145x30+a37x29+a242x28+a203x27+a134x26+a254x25+a89x24+a190x23+a94x22+a59x21+a65x20+a124x19+a113x18+a100x17+a233x16+a235x15+a121x14+a22x13+a76x12+a86x11+a97x10+a39x9+a242x8+a200x7+a220x6+a101x5+a33x4+a239x3+a254x2+a116x+a51
x54+a183x53+a26x52+a201x51+a87x50+a210x49+a221x48+a113x47+a21x46+a46x45+a65x44+a45x43+a50x42+a238x41+a184x40+a249x39+a225x38+a102x37+a58x36+a209x35+a218x34+a109x33+a165x32+a26x31+a95x30+a184x29+a192x28+a52x27+a245x26+a35x25+a254x24+a238x23+a175x22+a172x21+a79x20+a123x19+a25x18+a122x17+a43x16+a120x15+a108x14+a215x13+a80x12+a128x11+a201x10+a235x9+a8x8+a153x7+a59x6+a101x5+a31x4+a198x3+a76x2+a31x+a156
x56+a106x55+a120x54+a107x53+a157x52+a164x51+a216x50+a112x49+a116x48+a2x47+a91x46+a248x45+a163x44+a36x43+a201x42+a202x41+a229x40+a6x39+a144x38+a254x37+a155x36+a135x35+a208x34+a170x33+a209x32+a12x31+a139x30+a127x29+a142x28+a182x27+a249x26+a177x25+a174x24+a190x23+a28x22+a10x21+a85x20+a239x19+a184x18+a101x17+a124x16+a152x15+a206x14+a96x13+a23x12+a163x11+a61x10+a27x9+a196x8+a247x7+a151x6+a154x5+a202x4+a207x3+a20x2+a61x+a10
x58+a82x57+a116x56+a26x55+a247x54+a66x53+a27x52+a62x51+a107x50+a252x49+a182x48+a200x47+a185x46+a235x45+a55x44+a251x43+a242x42+a210x41+a144x40+a154x39+a237x38+a176x37+a141x36+a192x35+a248x34+a152x33+a249x32+a206x31+a85x30+a253x29+a142x28+a65x27+a165x26+a125x25+a23x24+a24x23+a30x22+a122x21+a240x20+a214x19+a6x18+a129x17+a218x16+a29x15+a145x14+a127x13+a134x12+a206x11+a245x10+a117x9+a29x8+a41x7+a63x6+a159x5+a142x4+a233x3+a125x2+a148x+a123
x60+a107x59+a140x58+a26x57+a12x56+a9x55+a141x54+a243x53+a197x52+a226x51+a197x50+a219x49+a45x48+a211x47+a101x46+a219x45+a120x44+a28x43+a181x42+a127x41+a6x40+a100x39+a247x38+a2x37+a205x36+a198x35+a57x34+a115x33+a219x32+a101x31+a109x30+a160x29+a82x28+a37x27+a38x26+a238x25+a49x24+a160x23+a209x22+a121x21+a86x20+a11x19+a124x18+a30x17+a181x16+a84x15+a25x14+a194x13+a87x12+a65x11+a102x10+a190x9+a220x8+a70x7+a27x6+a209x5+a16x4+a89x3+a7x2+a33x+a240
x62+a65x61+a202x60+a113x59+a98x58+a71x57+a223x56+a248x55+a118x54+a214x53+a94x52+x51+a122x50+a37x49+a23x48+a2x47+a228x46+a58x45+a121x44+a7x43+a105x42+a135x41+a78x40+a243x39+a118x38+a70x37+a76x36+a223x35+a89x34+a72x33+a50x32+a70x31+a111x30+a194x29+a17x28+a212x27+a126x26+a181x25+a35x24+a221x23+a117x22+a235x21+a11x20+a229x19+a149x18+a147x17+a123x16+a213x15+a40x14+a115x13+a6x12+a200x11+a100x10+a26x9+a246x8+a182x7+a218x6+a127x5+a215x4+a36x3+a186x2+a110x+a106
x64+a45x63+a51x62+a175x61+a9x60+a7x59+a158x58+a159x57+a49x56+a68x55+a119x54+a92x53+a123x52+a177x51+a204x50+a187x49+a254x48+a200x47+a78x46+a141x45+a149x44+a119x43+a26x42+a127x41+a53x40+a160x39+a93x38+a199x37+a212x36+a29x35+a24x34+a145x33+a156x32+a208x31+a150x30+a218x29+a209x28+a4x27+a216x26+a91x25+a47x24+a184x23+a146x22+a47x21+a140x20+a195x19+a195x18+a125x17+a242x16+a238x15+a63x14+a99x13+a108x12+a140x11+a230x10+a242x9+a31x8+a204x7+a11x6+a178x5+a243x4+a217x3+a156x2+a213x+a231
x66+a5x65+a118x64+a222x63+a180x62+a136x61+a136x60+a162x59+a51x58+a46x57+a117x56+a13x55+a215x54+a81x53+a17x52+a139x51+a247x50+a197x49+a171x48+a95x47+a173x46+a65x45+a137x44+a178x43+a68x42+a111x41+a95x40+a101x39+a41x38+a72x37+a214x36+a169x35+a197x34+a95x33+a7x32+a44x31+a154x30+a77x29+a111x28+a236x27+a40x26+a121x25+a143x24+a63x23+a87x22+a80x21+a253x20+a240x19+a126x18+a217x17+a77x16+a34x15+a232x14+a106x13+a50x12+a168x11+a82x10+a76x9+a146x8+a67x7+a106x6+a171x5+a25x4+a132x3+a93x2+a45x+a105
x68+a247x67+a159x66+a223x65+a33x64+a224x63+a93x62+a77x61+a70x60+a90x59+a160x58+a32x57+a254x56+a43x55+a150x54+a84x53+a101x52+a190x51+a205x50+a133x49+a52x48+a60x47+a202x46+a165x45+a220x44+a203x43+a151x42+a93x41+a84x40+a15x39+a84x38+a253x37+a173x36+a160x35+a89x34+a227x33+a52x32+a199x31+a97x30+a95x29+a231x28+a52x27+a177x26+a41x25+a125x24+a137x23+a241x22+a166x21+a225x20+a118x19+a2x18+a54x17+a32x16+a82x15+a215x14+a175x13+a198x12+a43x11+a238x10+a235x9+a27x8+a101x7+a184x6+a127x5+a3x4+a5x3+a8x2+a163x+a238`;

/**
 * This horrendously formatted nightmare comes from tables 13 to 22 in the spec
 */
const RAW_ERROR_CORRECTION_TABLES = `1
 26
L
   7
 1
(26,19,2)
            M
   10
   1
   (26,16,4)
   Q
13
1
(26,13,6)
            H
   17
   1
   (26,9,8)
  2
44
L
10
1
(44,34,4)
            M
   16
   1
   (44,28,8)
   Q
22
1
(44,22,11)
       H
  28
 1
 (44,16,14)
   3
    70
 L
   15
   1
   (70,55,7)
   M
26
1
(70,44,13)
            Q
   36
   2
   (35,17,9)
   H
44
2
(35,13,11)
   4
 100
L
  20
 1
 (100,80,10)
            M
   36
   2
   (50,32,9)
   Q
52
2
(50,24,13)
            H
   64
   4
   (25,9,8)
  5
134
L
26
1
(134,108,13)
            M
   48
   2
   (67,43,12)
        Q
 72
 2 2
 (33,15,9) (34,16,9)
   H
88
2 2
(33,11,11) (34,12,11)
   6
 172
L
  36
 2
 (86,68,9)
            M
   64
   4
   (43,27,8)
        Q
 96
 4
 (43,19,12)
        H
 112
  4
 (43,15,14)
   7
196
   L
 40
 2
 (98,78,10)
             M
    72
   4
   (49,31,9)
    Q
108
2 4
(32,14,9) (33,15,9)
         H
 130
 4 1
 (39,13,13) (40,14,13)
   8
  242
    L
    48
   2
   (121,97,12)
        M
  88
 2 2
 (60,38,11) (61,39,11)
    Q
132
4 2
(40,18,11) (41,19,11)
         H
 156
 4 2
 (40,14,13) (41,15,13)
   9
  292
    L
    60
   2
   (146,116,15)
        M
  110
 3 2
 (58,36,11) (59,37,11)
    Q
160
4 4
(36,16,10) (37,17,10)
         H
 192
 4 4
 (36,12,12) (37,13,12)
   10
  346
    L
    72
   2 2
   (86,68,9) (87,69,9)
    M
130
4 1
(69,43,13) (70,44,13)
             Q
    192
   6 2
   (43,19,12) (44,20,12)
        H
  224
 6 2
 (43,15,14) (44,16,14)
   11
    404
   L
   80
  4
  (101,81,10)
    M
150
1 4
(80,50,15) (81,51,15)
              Q
  224
  4 4
   (50,22,14) (51,23,14)
    H
264
3 8
(36,12,12) (37,13,12)
   12
 466
 L
96
 2 2
 (116,92,12) (117,93,12)
              M
  176
  6 2
   (58,36,11) (59,37,11)
    Q
260
4 6
(46,20,13) (47,21,13)
         H
308
 7 4
 (42,14,14) (43,15,14)
   13
    532
   L
  104
  4
   (133,107,13)
         M
 198
8 1
 (59,37,11) (60,38,11)
    Q
288
8 4
(44,20,12) (45,21,12)
              H
  352
  12 4
   (33,11,11) (34,12,11)
  14
581
L
120
3 1
(145,115,15) (146,116,15)
              M
  216
  4 5
   (64,40,12) (65,41,12)
         Q
 320
11 5
 (36,16,10) (37,17,10)
         H
 384
 11 5
 (36,12,12) (37,13,12)
   15
655
 L
 132
 5 1
 (109,87,11) (110,88,11)
            M
   240
  5 5
  (65,41,12) (66,42,12)
    Q
360
5 7
(54,24,15) (55,25,15)
            H
   432
  11 7
  (36,12,12) (37,13,12)
  16
733
L
144
5 1
(122,98,12) (123,99,12)
            M
   280
  7 3
  (73,45,14) (74,46,14)
    Q
408
15 2
(43,19,12) (44,20,12)
        H
 480
3 13
 (45,15,15) (46,16,15)
   17
   815
  L
   168
  1 5
  (135,107,14) (136,108,14)
    M
308
10 1
(74,46,14) (75,47,14)
            Q
   448
  1 15
  (50,22,14) (51,23,14)
    H
532
2 17
(42,14,14) (43,15,14)
   18
901
 L
 180
5 1
 (150,120,15) (151,121,15)
            M
   338
  9 4
  (69,43,13) (70,44,13)
        Q
 504
 17 1
(50,22,14) (51,23,14)
        H
 588
 2 19
 (42,14,14) (43,15,14)
   19
 991
 L
 196
 3 4
(141,113,14) (142,114,14)
              M
  364
  3 11
   (70,44,13) (71,45,13)
    Q
546
17 4
(47,21,13) (48,22,13)
              H
  650
  9 16
   (39,13,13) (40,14,13)
  20
1 085
L
224
3 5
(135,107,14) (136,108,14)
              M
  416
  3 13
   (67,41,13) (68,42,13)
    Q
600
15 5
(54,24,15) (55,25,15)
         H
700
 15 10
 (43,15,14) (44,16,14)
   21
 1 156
 L
224
 4 4
 (144,116,14) (145,117,14)
              M
  442
  17
   (68,42,13)
    Q
644
17 6
(50,22,14) (51,23,14)
         H
750
 19 6
 (46,16,15) (47,17,15)
   22
 1 258
 L
252
 2 7
 (139,111,14) (140,112,14)
              M
  476
  17
   (74,46,14)
    Q
690
7 16
(54,24,15) (55,25,15)
              H
  816
   34
   (37,13,12)
   23
1 364
 L
 270
 4 5
 (151,121,15) (152,122,15)
            M
   504
  4 14
  (75,47,14) (76,48,14)
    Q
750
11 14
(54,24,15) (55,25,15)
            H
   900
  16 14
  (45,15,15) (46,16,15)
  24
1 474
L
300
6 4
(147,117,15) (148,118,15)
            M
   560
  6 14
  (73,45,14) (74,46,14)
    Q
810
11 16
(54,24,15) (55,25,15)
        H
 960
30 2
 (46,16,15) (47,17,15)
   25
   1 588
  L
   312
  8 4
  (132,106,13) (133,107,13)
    M
588
8 13
(75,47,14) (76,48,14)
            Q
   870
  7 22
  (54,24,15) (55,25,15)
    H
1050
22 13
(45,15,15) (46,16,15)
   26
1 706
 L
 336
10 2
 (142,114,14) (143,115,14)
            M
   644
  19 4
  (74,46,14) (75,47,14)
        Q
 952
 28 6
(50,22,14) (51,23,14)
        H
 1110
 33 4
 (46,16,15) (47,17,15)
   27
 1 828
 L
 360
 8 4
(152,122,15) (153,123,15)
              M
  700
  22 3
   (73,45,14) (74,46,14)
    Q
1 020
8 26
(53,23,15) (54,24,15)
              H
  1 200
  12 28
   (45,15,15) (46,16,15)
  28
1 921
L
390
3 10
(147,117,15) (148,118,15)
              M
  728
  3 23
   (73,45,14) (74,46,14)
    Q
1 050
4 31
(54,24,15) (55,25,15)
         H
1 260
 11 31
 (45,15,15) (46,16,15)
   29
    2 051
   L
  420
  7 7
   (146,116,15) (147,117,15)
    M
784
21 7
(73,45,14) (74,46,14)
              Q
  1 140
  1 37
   (53,23,15) (54,24,15)
    H
1 350
19 26
(45,15,15) (46,16,15)
   30
 2 185
 L
450
 5 10
 (145,115,15) (146,116,15)
              M
  812
  19 10
   (75,47,14) (76,48,14)
         Q
 1 200
15 25
 (54,24,15) (55,25,15)
         H
 1 440
 23 25
 (45,15,15) (46,16,15)
   31
2 323
 L
 480
 13 3
 (145,115,15) (146,116,15)
            M
   868
  2 29
  (74,46,14) (75,47,14)
    Q
1 290
42 1
(54,24,15) (55,25,15)
        H
 1 530
23 28
 (45,15,15) (46,16,15)
   32
   2 465
  L
   510
  17
  (145,115,15)
        M
 924
 10 23
(74,46,14) (75,47,14)
    Q
1 350
10 35
(54,24,15) (55,25,15)
            H
   1 620
  19 35
  (45,15,15) (46,16,15)
  33
2 611
L
540
17 1
(145,115,15) (146,116,15)
            M
   980
  14 21
  (74,46,14) (75,47,14)
    Q
1 440
29 19
(54,24,15) (55,25,15)
        H
 1 710
11 46
 (45,15,15) (46,16,15)
   34
   2 761
  L
   570
  13 6
  (145,115,15) (146,116,15)
    M
1 036
14 23
(74,46,14) (75,47,14)
            Q
   1 530
  44 7
  (54,24,15) (55,25,15)
        H
 1 800
 59 1
 (46,16,15) (47,17,15)
   35
 2 876
 L
 570
 12 7
(151,121,15) (152,122,15)
              M
  1 064
  12 26
   (75,47,14) (76,48,14)
    Q
1 590
39 14
(54,24,15) (55,25,15)
              H
  1 890
  22 41
   (45,15,15) (46,16,15)
  36
3 034
L
600
6 14
(151,121,15) (152,122,15)
              M
  1 120
  6 34
   (75,47,14) (76,48,14)
    Q
1 680
46 10
(54,24,15) (55,25,15)
         H
1 980
 2 64
 (45,15,15) (46,16,15)
   37
    3 196
   L
  630
  17 4
   (152,122,15) (153,123,15)
    M
1 204
29 14
(74,46,14) (75,47,14)
              Q
  1 770
  49 10
   (54,24,15) (55,25,15)
    H
2 100
24 46
(45,15,15) (46,16,15)
   38
 3 362
 L
660
 4 18
 (152,122,15) (153,123,15)
              M
  1 260
  13 32
   (74,46,14) (75,47,14)
         Q
 1 860
48 14
 (54,24,15) (55,25,15)
         H
 2 220
 42 32
 (45,15,15) (46,16,15)
39
3 532
L
720
20 4
(147,117,15) (148,118,15)

M


1 316

40 7

(75,47,14) (76,48,14)
Q
1 950
43 22
(54,24,15) (55,25,15)

H


2 310

10 67

(45,15,15) (46,16,15)
40
3 706
L
750
19 6
(148,118,15) (149,119,15)

M


1 372

18 31

(75,47,14) (76,48,14)
Q

2 040

34 34

(54,24,15) (55,25,15)


H

2 430

20 61

(45,15,15) (46,16,15)`;

console.log(generateDataFile());
