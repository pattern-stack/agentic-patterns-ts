/**
 * The shared page kit (port-map §7.2) — barrel export. `lib/format.ts` and
 * `hooks/useSortedRows.ts` are the non-component half of the kit and stay in
 * their conventional homes rather than re-exporting through here.
 */
export { AnswerPanel } from "./AnswerPanel";
export { AsyncState, type AsyncStateKind, type AsyncStateProps } from "./AsyncState";
export { DropdownMenu, type DropdownMenuProps } from "./DropdownMenu";
export { Field, inputStyle } from "./Field";
export { JsonBlock } from "./JsonBlock";
export { Markdown } from "./Markdown";
export { PageHeader } from "./PageHeader";
export { SectionHeading, sectionMicroHeadingStyle } from "./SectionHeading";
export { Segmented, type SegmentedOption, type SegmentedProps } from "./Segmented";
export { Stat, type StatTone } from "./Stat";
