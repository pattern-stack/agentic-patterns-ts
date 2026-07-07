/**
 * Legacy re-export shim (port-map §7.1). The two atom sets have folded into
 * one — `components/atoms/` is home; this module used to hold its own
 * cockpit-flavored Badge/Card/Button/Tabs/Field. Its only remaining consumers
 * (`chat/ChatComposer.tsx`, `pages/RunSurfacePage.tsx`) used just Badge +
 * Button, so that's all that's re-exported here. `components/atoms/Badge`'s
 * `Tone` now accepts every value the cockpit `Tone` used to (`ok | err | warn
 * | accent | mute | run | violet`) plus the legacy admin names, so both
 * remaining call sites work unchanged. Delete this file (and repoint those two
 * imports at `components/atoms/*` directly) in S8.
 */
export { Badge, type BadgeTone, type BadgeVariant, type Tone } from "../components/atoms/Badge";
export { Button, type ButtonSize, type ButtonVariant } from "../components/atoms/Button";
