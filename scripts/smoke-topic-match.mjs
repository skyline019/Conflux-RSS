/** Quick offline checks for topicRelevance scoring logic (mirrored). */
function normalizeTitle(title) {
  return (title || "")
    .toLowerCase()
    .replace(/[|｜\-—_·•:：,，。、；;！!？?'"「」『』【】[\]()（）<>《》\s]+/g, "")
    .slice(0, 200);
}

function bigramSet(s) {
  const norm = s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const set = new Set();
  for (const word of norm.split(/\s+/)) {
    if (!word) continue;
    if (/^[a-z0-9]+$/.test(word)) {
      set.add(word);
      continue;
    }
    if (word.length === 1) {
      set.add(word);
      continue;
    }
    for (let i = 0; i < word.length - 1; i++) set.add(word.slice(i, i + 2));
  }
  return set;
}

function titleSimilarity(a, b) {
  const sa = bigramSet(a);
  const sb = bigramSet(b);
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  sa.forEach((x) => {
    if (sb.has(x)) inter++;
  });
  return inter / (sa.size + sb.size - inter);
}

function topicRelevance(expected, gotTitle, body = "") {
  const exp = (expected || "").trim();
  if (!exp) return 1;
  const got = (gotTitle || "").trim();
  const tSim = got ? titleSimilarity(exp, got) : 0;
  const hay = `${got} ${body.slice(0, 1200)}`.toLowerCase();
  const nExp = normalizeTitle(exp);
  const nGot = normalizeTitle(got);
  const contain =
    nExp.length >= 4 && nGot.length >= 4 && (nGot.includes(nExp) || nExp.includes(nGot.slice(0, Math.min(24, nGot.length))))
      ? 0.85
      : 0;
  return Math.max(contain, tSim);
}

const cases = [
  ["Swisse两款产品被检出不合格", "Swisse两款保健品抽检不合格，涉事批次下架", "匹配"],
  ["Swisse两款产品被检出不合格", "沪指收涨逾1% 创业板指涨超2%", "错文"],
  ["四部门：加强汽车研发测试验证管理", "四部门发文加强汽车研发测试验证管理", "匹配"],
  ["四部门：加强汽车研发测试验证管理", "清明假期全国接待游客1.2亿人次", "错文"],
];

for (const [q, t, label] of cases) {
  const s = topicRelevance(q, t, t);
  console.log(label, s.toFixed(3), s >= 0.28 ? "ACCEPT" : "REJECT", "|", q.slice(0, 16), "→", t.slice(0, 24));
}
