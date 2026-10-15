# Per-document score display preference contract

2026-10-16. Accepted source: `6a634c4f5017dcb6ec515f5cea3aaaae183f25fb` on `feat/gp8-parity`. This is the view-contract slice of `docs/superpowers/specs/2026-10-16-gp8-score-layouts-design.md`, not delivery of the six live score modes.

The optional `scoreDisplay:{layout,zoomMode}` now survives frontend repair, addressed workspace view writes, document activation and native serde/recovery data. It supports six layout names and three zoom policies. Existing views retain their exact absent-field shape; null becomes absence natively. Frontend resolution defaults to Parchment/manual and normalizes endless Fit page to Fit width. Numeric manual zoom remains independent and fractional25–300%.

Native uses ordinary strict-field serde enums/structs. Valid enum pairs roundtrip unchanged, including endless Fit page before frontend applicability repair. Ordinary serde positional two-value sequences also normalize to named-field objects; this approved boundary is preserved explicitly, not described as exclusive JSON-object validation. Frontend arrays and malformed/extra-key preferences are dropped.

## Evidence

- Behavioral frontend RED before production changes:1failed/11passed; supplied grid/Fit page disappears while137.5 survives. Native RED:1failed/1passed; supplied scoreDisplay rejected as unknown. Both are retained in this plan's SDD workspace.
- Producer focused GREEN:130tests/4frontend files, TypeScript0, seven matching native contract tests covering all18enum pairs. Native GREEN preceded one test-only rustfmt line wrap; final fmt check0. Other recovery integration targets compiled but were not executed by this filter.
- Root independently checked all ten released file hashes, then reran the same four frontend files:130passed, exit0. Root typecheck also passed in the current worktree, with the disjoint geometry lane present; this is not a whole-suite or native rerun.
- Fresh independent source/test/receipt review: PASS, no actionable findings. Review SHA-256 `15ECDB40BC79E11D8988F67BE1182345814B940A70B382F1EC2573442125B133`. It independently matched all release hashes and inspected the immutable packet once; it did not rerun tests.

Commands: `npx vitest run src/engraving/screen-view.test.ts src/workspace/view-state.test.ts src/workspace/WorkspaceController.test.ts src/workspace/session-bridge.test.ts --maxWorkers=2 --reporter=dot`; `npm run typecheck`; producer-only `cargo test --manifest-path src-tauri/Cargo.toml --locked score_display -- --nocapture`; `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`.

Producer report: `.superpowers/sdd/2026-10-16-gp8-score-display-preferences/task-1-report.md`, SHA-256 `74A08DB1E58BC88FFAA68E0DAEEBE21F19E577AC6668C70FC035DE7B032F95B5`. Root focused receipt `task-2-root-focused.log`: `E6F6CB239273AF7B427B221539441CAEC3EA2286B663455EF6C8E206810D4710`; root type receipt `task-2-root-typecheck.log`: `EC5776F12086906BF4E72E53A33DD3354AAFC4227134457F808D612631FEB1D6`. Independent review: `.analysis/parity/score-display-preferences-independent-review.md`.

## Frozen source fingerprints

| File | SHA-256 |
|---|---|
|`src/engraving/screen-view.ts`|`C81CB0CC0168BE467EF333F967DC7D5123F9567C9196E862EE15CA04A9F01F28`|
|`src/engraving/screen-view.test.ts`|`FDA69328C075D61D37765994EEB9D93E0FE30ED5374A42A7703458FE8FE3134B`|
|`src/workspace/types.ts`|`5F18C56B79BF2A74783B0436C1629F4898F6A18005AF91510C818CF1AD574A32`|
|`src/workspace/view-state.ts`|`29D5D1260F82618597A77B53DB7BF0F150C717476F5ABFF133FD3821D6FB9ED4`|
|`src/workspace/view-state.test.ts`|`E517D7D052B582D612EC19F8189DE1C6D7C07BBDBD820A491A775C8571887BE7`|
|`src/workspace/WorkspaceController.test.ts`|`1C955F3B99AE037D68502315A9112C346C458AA733D788EB55C7A2CE33EF6C86`|
|`src/workspace/session-bridge.test.ts`|`D72553422D56765BC10BC22DC14A8EE87C7CD32066ACC870C97B60EBF163B1E2`|
|`src-tauri/src/recovery.rs`|`B73BFEF364FB3D700293305D83322C600244F75106F21AACB806B5F88ED2CEA6`|
|`src-tauri/tests/recovery.rs`|`9056BFD3E01AFA56D0262FD711C7D5B8762F0E1079B46163CFBA2CBE136D3D8A`|
|`src-tauri/tests/workspace_recovery.rs`|`6F40366F56F8CA8DD4AD22171B0C412C64B068EF9038CBD9D8D13D0A8C1F6AC7`|

The real WorkspaceController test preserves state/project identity, revision, dirty state and redo availability through view writes and activation, then executes redo successfully. The bridge test asserts the existing addressed payload. Existing manual zoom validation and initial view source remain unchanged. The two auxiliary Rust initializer edits add only `score_display:None`; no production bridge/controller/audio behavior changed.

No UI, desktop save/reopen observation, page rendering, selection/cursor, fit geometry, physical audio, original GP8, cross-platform or shipping acceptance is claimed here. D01/D02 remain partial; the parity overlay is unchanged. Actual GenAI images and a source-bound throwaway page probe are separate preparation evidence, not runtime proof. Released main is untouched.
