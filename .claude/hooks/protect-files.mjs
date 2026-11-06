// PreToolUse: stop edits to generated files and confirm edits to approved tone.
import { readFileSync } from 'node:fs';

const denied = ['/src-tauri/gen/', '/src-tauri/resources/audio/', '/.analysis/compatibility/'];
const confirmed = ['/src-tauri/src/audio/tone.rs'];

const input = JSON.parse(readFileSync(0, 'utf8'));
const file = `/${(input.tool_input?.file_path ?? '').replaceAll('\\', '/')}`;

const decide = (permissionDecision, permissionDecisionReason) => {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason } }));
  process.exit(0);
};

if (denied.some((path) => file.includes(path))) decide('deny', 'This path is generated or fetched. Change its source script instead.');
if (confirmed.some((path) => file.endsWith(path))) decide('ask', 'The tone was approved by ear. Confirm the user asked for this change.');
