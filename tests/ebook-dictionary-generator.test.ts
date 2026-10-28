import { describe, expect, it } from "vitest";
import { buildPack, parseCsv } from "../scripts/generate-ebook-dictionary.mjs";

describe("ECDICT source generation", () => {
  const header = "word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail,audio\n";
  it("parses quoted commas, doubled quotes, and real newlines correctly", () => {
    const rows: string[][] = [];
    parseCsv('a,"he said ""hi""",,"n. 你好，世界\nv. 说话",,,,,1,1,,,\n', row => rows.push(row));
    expect(rows).toHaveLength(1);
    expect(rows[0][1]).toBe('he said "hi"');
    expect(rows[0][3]).toContain("\n");
    expect(rows[0][3]).toContain("，");
  });
  it("filters to prioritized English words with Chinese meanings and maps inflections", () => {
    const csv = header +
      'walk,wɔːk,,v. 行走,,,1,cet4,100,200,p:walked/i:walking,,\n' +
      'quiet,ˈkwaɪət,,a. 安静的,,,1,cet4,250,300,,,\n' +
      'something,,,"english only",,,,200,300,,,\n' +
      'other,,,"n. 其他",,,,0,0,,,\n';
    const pack = buildPack(csv, 2);
    expect(pack.count).toBe(2);
    expect(pack.buckets.w.words.walk).toEqual(["wɔːk", "v. 行走"]);
    expect(pack.buckets.w.forms.walked).toBe("walk");
    expect(pack.buckets.w.forms.walking).toBe("walk");
    expect(pack.buckets.q.words.quiet).toEqual(["ˈkwaɪət", "a. 安静的"]);
    expect(pack.buckets.o.words.other).toBeUndefined();
  });
});
