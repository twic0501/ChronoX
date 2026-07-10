import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SKILL_METAS, matchSkill } from "@/lib/ai/skills/registry";

const SKILLS_DIR = join(import.meta.dir, "../../lib/ai/skills");

describe("Agent skill registry", () => {
	test("every skill has a unique name, description and keywords", () => {
		const names = SKILL_METAS.map((s) => s.name);
		expect(new Set(names).size).toBe(names.length);
		for (const s of SKILL_METAS) {
			expect(s.name.length).toBeGreaterThan(0);
			expect(s.description.length).toBeGreaterThan(20);
			expect(s.keywords.length).toBeGreaterThan(2);
		}
	});

	test("every registered skill has a real markdown recipe on disk", () => {
		for (const s of SKILL_METAS) {
			const file = join(SKILLS_DIR, `${s.name}.skill.md`);
			expect(existsSync(file)).toBe(true);
			const content = readFileSync(file, "utf8");
			// Non-trivial content with a title heading.
			expect(content.startsWith("# Skill:")).toBe(true);
			expect(content.length).toBeGreaterThan(400);
		}
	});

	test("matchSkill resolves exact names, substrings and keywords", () => {
		expect(matchSkill("transitions", SKILL_METAS)?.name).toBe("transitions");
		expect(matchSkill("grading", SKILL_METAS)?.name).toBe("color-grading");
		// keyword hits — the way the agent actually queries ("grid", "beat")
		expect(matchSkill("grid", SKILL_METAS)?.name).toBe("masks-grid");
		expect(matchSkill("split screen layout", SKILL_METAS)?.name).toBe(
			"masks-grid",
		);
		expect(matchSkill("how to sync cuts to the beat", SKILL_METAS)?.name).toBe(
			"beat-sync",
		);
		expect(matchSkill("ken burns", SKILL_METAS)?.name).toBe(
			"transform-animation",
		);
		expect(matchSkill("rule of six", SKILL_METAS)?.name).toBe("editing-theory");
		expect(matchSkill("j-cut", SKILL_METAS)?.name).toBe("cut-types");
		expect(matchSkill("what does a dissolve mean", SKILL_METAS)?.name).toBe(
			"transition-psychology",
		);
		expect(matchSkill("", SKILL_METAS)).toBeUndefined();
		expect(matchSkill("quantum chromodynamics", SKILL_METAS)).toBeUndefined();
	});
});
