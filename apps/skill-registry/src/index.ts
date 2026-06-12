import { Skill, newId } from "@companyos/schemas";
import { runSuite, type EvalInput, type SuiteOptions } from "@companyos/eval-service";

/**
 * Skill registry (PHASE-05): portable, versioned skill packages with an
 * eval-gated promotion (draft -> active only when the eval suite passes, FR-5.7).
 */

export interface SkillPackage {
  SKILL_md?: string;
  tools_json?: { inputSchema?: unknown; outputSchema?: unknown; requiredTools?: unknown[] };
  evals_yaml?: SuiteOptions & { cases?: unknown[] };
}

export interface PackageValidation {
  valid: boolean;
  errors: string[];
}

export function validatePackage(pkg: SkillPackage): PackageValidation {
  const errors: string[] = [];
  if (!pkg.SKILL_md || pkg.SKILL_md.trim().length === 0) errors.push("missing SKILL.md");
  if (!pkg.tools_json) errors.push("missing tools.json");
  else {
    if (!pkg.tools_json.inputSchema) errors.push("tools.json: missing inputSchema");
    if (!pkg.tools_json.outputSchema) errors.push("tools.json: missing outputSchema");
  }
  if (!pkg.evals_yaml || !Array.isArray(pkg.evals_yaml.evals) || pkg.evals_yaml.evals.length === 0) {
    errors.push("missing evals.yaml with at least one eval");
  }
  return { valid: errors.length === 0, errors };
}

interface StoredSkill extends Skill {
  evalSuite?: SuiteOptions;
  changelog: string[];
}

export class SkillRegistry {
  private skills = new Map<string, StoredSkill>();

  /** Register/sync a skill from a source (Notion/GitHub). Validates the package. */
  register(input: Partial<Skill> & Pick<Skill, "orgId" | "name" | "owner" | "source" | "sourceRef">, pkg: SkillPackage): StoredSkill {
    const v = validatePackage(pkg);
    if (!v.valid) throw new Error(`invalid skill package: ${v.errors.join("; ")}`);
    const skill = Skill.parse({ ...input, id: input.id ?? newId("skill") }) as StoredSkill;
    skill.evalSuite = pkg.evals_yaml
      ? { evals: pkg.evals_yaml.evals, thresholds: pkg.evals_yaml.thresholds ?? {}, gate: pkg.evals_yaml.gate ?? "block" }
      : undefined;
    skill.changelog = [`${skill.version}: registered from ${skill.source}`];
    this.skills.set(skill.id, skill);
    return skill;
  }

  /** Re-sync produces a new version with a diff entry (FR-5.4). */
  sync(id: string, patch: Partial<Skill>, note: string): StoredSkill {
    const cur = this.skills.get(id);
    if (!cur) throw new Error(`skill ${id} not found`);
    const next = { ...cur, ...patch, id } as StoredSkill;
    next.changelog = [...cur.changelog, `${next.version}: ${note}`];
    this.skills.set(id, next);
    return next;
  }

  get(id: string): StoredSkill | undefined {
    return this.skills.get(id);
  }

  list(orgId: string, opts?: { role?: string }): StoredSkill[] {
    return [...this.skills.values()].filter(
      (s) => s.orgId === orgId && (!opts?.role || s.allowedRoles.length === 0 || s.allowedRoles.includes(opts.role))
    );
  }

  /**
   * Promotion gate: run the skill's eval suite over the candidate output.
   * Promotes draft -> active only if the suite passes (FR-5.7, T05.7).
   */
  async promote(id: string, candidate: EvalInput): Promise<{ promoted: boolean; failures: string[] }> {
    const skill = this.skills.get(id);
    if (!skill) throw new Error(`skill ${id} not found`);
    if (!skill.evalSuite) throw new Error("skill has no eval suite");
    const result = await runSuite(candidate, skill.evalSuite);
    if (result.passed) {
      skill.status = "active";
      skill.changelog.push(`${skill.version}: promoted to active (evals passed)`);
      return { promoted: true, failures: [] };
    }
    return { promoted: false, failures: result.failures };
  }
}
