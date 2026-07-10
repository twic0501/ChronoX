/**
 * Agent Skills — markdown technique recipes the editing agent retrieves on
 * demand (agentic RAG): it lists skills, reads the relevant one, and applies
 * the documented recipe with its tools instead of improvising parameters.
 */
import transitionsMd from "./transitions.skill.md";
import colorGradingMd from "./color-grading.skill.md";
import transformAnimationMd from "./transform-animation.skill.md";
import masksGridMd from "./masks-grid.skill.md";
import beatSyncMd from "./beat-sync.skill.md";
import editingTheoryMd from "./editing-theory.skill.md";
import cutTypesMd from "./cut-types.skill.md";
import transitionPsychologyMd from "./transition-psychology.skill.md";
import pacingMontageMd from "./pacing-montage.skill.md";
import { type AgentSkill, SKILL_METAS, matchSkill } from "./registry";

const CONTENT: Record<string, string> = {
	transitions: transitionsMd,
	"color-grading": colorGradingMd,
	"transform-animation": transformAnimationMd,
	"masks-grid": masksGridMd,
	"beat-sync": beatSyncMd,
	"editing-theory": editingTheoryMd,
	"cut-types": cutTypesMd,
	"transition-psychology": transitionPsychologyMd,
	"pacing-montage": pacingMontageMd,
};

export const SKILLS: AgentSkill[] = SKILL_METAS.map((meta) => ({
	...meta,
	content: CONTENT[meta.name] ?? "",
}));

export function listSkills(): { name: string; description: string }[] {
	return SKILLS.map(({ name, description }) => ({ name, description }));
}

export function getSkill(query: string): AgentSkill | undefined {
	return matchSkill(query, SKILLS);
}
