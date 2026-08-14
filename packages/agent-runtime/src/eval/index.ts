// @pattern-stack/agentic-runtime — eval barrel (spec § Approach step 5)

export {
  type EvalCase,
  EvalCaseSchema,
  type EvalSplit,
  EvalSplitSchema,
  type Score,
  ScoreSchema,
  type EvalResult,
  EvalResultSchema,
  type EvalReport,
  EvalReportSchema,
  type EvalTargetKind,
} from "./types.js";

export { type Scorer, exactMatch, predicateScorer } from "./scorer.js";

export { type EvalTarget, isNodeShape, isAgentLikeShape, resolveEvalTarget } from "./target.js";

export { EVAL_TRACE_PREFIX, type EvalRunContext, type EvalSpec, runEval } from "./run-eval.js";

export {
  assertSplitSelectable,
  CaseBankLoadError,
  filterBySplit,
  HeldOutSplitError,
  loadCasesJsonl,
  loadGold,
  type SplitSelectOptions,
} from "./case-bank.js";

export {
  type SetMembershipArgs,
  type SetMembershipOptions,
  setMembership,
} from "./scorers/set-membership.js";

export {
  JUDGE_AXES,
  type JudgeAxis,
  JudgeVerdictSchema,
  type JudgeVerdict,
  type JudgeThresholds,
  type JudgeScorerOptions,
  judgeScorer,
} from "./scorers/judge.js";
