import type { FilterRule } from "@/db/schema";

export interface RuleSubject {
  title: string;
  content: string;
  author: string | null;
  feedId: number;
}

export interface RuleVerdict {
  blocked: boolean;
  starred: boolean;
  markRead: boolean;
  archive: boolean;
  matchedRules: { id: number; name: string; action: string }[];
}

function fieldText(rule: FilterRule, s: RuleSubject): string {
  switch (rule.field) {
    case "title": return s.title;
    case "content": return s.content;
    case "author": return s.author || "";
    case "any": return `${s.title}\n${s.author || ""}\n${s.content}`;
    default: return s.title;
  }
}

export function matchRule(rule: FilterRule, s: RuleSubject): boolean {
  if (!rule.enabled) return false;
  if (rule.feedId != null && rule.feedId !== s.feedId) return false;
  const text = fieldText(rule, s);
  const lower = text.toLowerCase();
  try {
    switch (rule.operator) {
      case "contains": {
        const kws = rule.pattern.split(/[,，、|]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
        return kws.some((k) => lower.includes(k));
      }
      case "not_contains": {
        const kws = rule.pattern.split(/[,，、|]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
        return kws.length > 0 && !kws.some((k) => lower.includes(k));
      }
      case "equals":
        return lower.trim() === rule.pattern.trim().toLowerCase();
      case "regex":
        return new RegExp(rule.pattern, "i").test(text);
      default:
        return false;
    }
  } catch {
    return false; // invalid regex never matches
  }
}

/** Apply all rules (sorted by priority asc). Block wins over everything. */
export function applyRules(rules: FilterRule[], s: RuleSubject): RuleVerdict {
  const verdict: RuleVerdict = { blocked: false, starred: false, markRead: false, archive: false, matchedRules: [] };
  const sorted = [...rules].sort((a, b) => a.priority - b.priority);
  for (const rule of sorted) {
    if (!matchRule(rule, s)) continue;
    verdict.matchedRules.push({ id: rule.id, name: rule.name, action: rule.action });
    if (rule.action === "block") verdict.blocked = true;
    else if (rule.action === "star") verdict.starred = true;
    else if (rule.action === "mark_read") verdict.markRead = true;
    else if (rule.action === "archive") verdict.archive = true;
  }
  return verdict;
}
