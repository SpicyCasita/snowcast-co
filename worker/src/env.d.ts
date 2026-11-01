// app/src/forecast/skill.ts reads import.meta.env in loadSkillWeights, which the Worker never calls.
interface ImportMeta {
  readonly env: { readonly BASE_URL?: string }
}

