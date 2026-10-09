import type { AtomicRequirement } from "../types.js";
import type { ProbeCase } from "./probe-schema.js";
import { maskRequirementLiterals, requirementSentences } from "../requirement-text.js";

export function validateFirstMatchInstructions(probeCase: ProbeCase, requirements: readonly AtomicRequirement[],
  prerequisites: readonly AtomicRequirement[]): void {
  const scenarioIds = new Set(probeCase.outcomeChecks?.map(check => check.scenarioId));
  const scoped = requirements.map(item => scenarioIds.size ? { ...item,
    scenarios: (item.scenarioContracts ?? []).filter(scenario => scenarioIds.has(scenario.id)).map(scenario =>
      scenario.steps.map(step => step.content).join("\n")),
    scenarioContracts: (item.scenarioContracts ?? []).filter(scenario => scenarioIds.has(scenario.id)),
  } : item);
  const evidence = [...scoped, ...prerequisites].flatMap(item => [item.product.description, item.text,
    ...item.ancestors.map(ancestor => ancestor.description),
    ...(item.scenarioContracts?.length ? item.scenarioContracts.flatMap(scenario => scenario.steps.map(step => step.content)) : item.scenarios)]);
  for (const step of probeCase.steps) {
    const locators = "locator" in step ? [step.locator] : step.op === "drag" ? [step.from, step.to] : [];
    for (const locator of locators.flatMap(locator => [locator, ...(locator.fallbacks ?? [])])) {
      const quote = locator.firstMatch;
      if (!quote) continue;
      if (step.op === "expectCount" || step.op === "expectHidden") throw new Error("firstMatch cannot narrow an absence or count assertion");
      if (!evidence.some(text => text.includes(quote))) {
        throw new Error(`Case ${probeCase.id}.firstMatch must quote the requirement evidence verbatim`);
      }
      const sourceInstruction = evidence.some(text => {
        const start = text.indexOf(quote);
        return start >= 0 && maskRequirementLiterals(text).slice(start, start + quote.length) === maskRequirementLiterals(quote);
      });
      if (!sourceInstruction) throw new Error(`Case ${probeCase.id}.firstMatch must quote a prose instruction, not a data literal`);
      const name = locator.by === "role" ? locator.name! : locator.text;
      const quotedNames = [...quote.matchAll(/`([^`]+)`|"([^"\n]+)"|“([^”]+)”/g)];
      const selectsTarget = quotedNames.some(match => (match[1] ?? match[2] ?? match[3]) === name &&
        /(?:\bfirst(?:\s+visible)?\s+(?:(?:button|link|control|option|field)\s+(?:named\s+)?)?|第一个(?:名为)?)[\s]*$/i
          .test(maskRequirementLiterals(quote.slice(0, match.index))));
      // A declared "Add comment" button on a changed line also binds "start a
      // comment on the first changed line". Require both the same action word
      // and an explicit named-control/container relationship in source prose.
      const prose = maskRequirementLiterals(quote);
      const parent = /\b(?:on|in|within)\s+(?:the\s+)?first\s+([a-z][a-z -]*?)(?=[,.;!?]|$)/i.exec(prose)?.[1].trim();
      const parentWords: string[] = parent?.toLowerCase().match(/\b[a-z]+\b/g) ?? [];
      const words = (name.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter(word => !parentWords.includes(word));
      const proseWords: string[] = prose.toLowerCase().match(/\b[a-z]+\b/g) ?? [];
      const sameAction = words.some(word => proseWords.includes(word));
      const containerPattern = parent && new RegExp(`\\b(?:on|in|within)\\s+(?:(?:a|an|the|each)\\s+)?${parent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      const selectsContainer = sameAction && containerPattern && evidence.flatMap(text => requirementSentences(text.replace(/\r?\n/g, " "))).some(sentence =>
        [...sentence.matchAll(/`([^`]+)`|"([^"\n]+)"|“([^”]+)”/g)].some(match => (match[1] ?? match[2] ?? match[3]) === name) &&
        containerPattern.test(maskRequirementLiterals(sentence)));
      if (!selectsTarget && !selectsContainer) throw new Error(`Case ${probeCase.id}.firstMatch must explicitly select the first ${name} control`);
    }
  }
}

