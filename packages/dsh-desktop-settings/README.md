# Desktop employee settings

Presentation-only host plugin for Harness 0.2.0-rc.2. It uses the existing settings shell and feature-owned components; no account, model or preference data is copied into this package.

- One account-owned sidebar launcher uses the existing `settings.launcher` slot. Its menu shows Settings, Approvals, Connect phone and Log out in that order. The original Settings shortcut and shell remain owned by Harness.
- Harness owns the flat section navigation, General rows, header actions and Plugins tabs. Bisheng adds account details, usage, personal access and About through the existing slots; no Advanced disclosure groups override the framework.
- Settings rows and technical plugin inventory remain owned by their original features and render once. Approvals use a separate modal and are not registered as a settings section.
- Enterprise account details, usage and approvals occupy a bounded native document surface. The Chat/Work presenter remains its single geometry owner.
- The native enterprise service owns logout. Web settings receive only readiness, close and focus presentation channels.
- Phone pairing uses the existing native pairing window. The preload retains its legacy phone button only when this optional account launcher is absent, including Safe Mode.
- Styles and subscriptions follow the Cordis lifetime. Missing host layout contributions preserve Harness defaults; Safe Mode does not compose this plugin.

The canonical slot types live in the reproducible `dsh-client-ui-settings` patch. Runtime declarations live with the respective shell and Plugins section owners. Remove the compatibility patches when upstream ships equivalent layouts.

See `docs/settings-integration.zh.md` in the Desktop repository for contracts and validation boundaries.
