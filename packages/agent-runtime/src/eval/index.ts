// @agentic-patterns/runtime — eval barrel (spec § Approach step 5)

export {
  type EvalCase,
  EvalCaseSchema,
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

export { type EvalRunContext, type EvalSpec, runEval } from "./run-eval.js";
