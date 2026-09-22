export interface CanonicalRedactionFixture {
  readonly name: string;
  readonly input: string;
  readonly expected: string;
  readonly secretFragments: readonly string[];
  readonly preservedFragments: readonly string[];
}

const marker = "[REDACTED_SECRET]";
const xaiKey = `xai-${"A".repeat(24)}`;
const bearerToken = "abc.DEF_ghi~jkl+/mnop=qrst";
const walletKey = "3".repeat(88);

export const canonicalRedactionFixtures = [
  {
    name: "xAI key beside punctuation",
    input: `xAI=(${xaiKey}), keep`,
    expected: `xAI=(${marker}), keep`,
    secretFragments: [xaiKey],
    preservedFragments: ["xAI=(", "), keep"],
  },
  {
    name: "opaque bearer token beside punctuation",
    input: `Authorization: Bearer ${bearerToken}; next`,
    expected: `Authorization: Bearer ${marker}; next`,
    secretFragments: [bearerToken],
    preservedFragments: ["Authorization: Bearer ", "; next"],
  },
  {
    name: "quoted assignment syntax",
    input: 'config api_key = "opaque-value-12345", timeout=30',
    expected: `config api_key = "${marker}", timeout=30`,
    secretFragments: ["opaque-value-12345"],
    preservedFragments: ['config api_key = "', '", timeout=30'],
  },
  {
    name: "bare wallet key material",
    input: `wallet (${walletKey}).`,
    expected: `wallet (${marker}).`,
    secretFragments: [walletKey],
    preservedFragments: ["wallet (", ")."],
  },
  {
    name: "ordinary token counters and public-key labels",
    input:
      "postCompactTokens=12345678; publicKey=ssh-rsa-example; meeting lasted forty minutes",
    expected:
      "postCompactTokens=12345678; publicKey=ssh-rsa-example; meeting lasted forty minutes",
    secretFragments: [],
    preservedFragments: [
      "postCompactTokens=12345678",
      "publicKey=ssh-rsa-example",
      "meeting lasted forty minutes",
    ],
  },
] as const satisfies readonly CanonicalRedactionFixture[];
