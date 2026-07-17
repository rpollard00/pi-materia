# Changelog

## [0.1.10](https://github.com/rpollard00/pi-materia/compare/v0.1.9...v0.1.10) (2026-07-17)


### Features

* add catalog provenance and drift detection ([30c70f2](https://github.com/rpollard00/pi-materia/commit/30c70f20be82aa1f7768564d0a6b9f306cfc02c9))
* add central catalog in-memory repository ([8c4c4ae](https://github.com/rpollard00/pi-materia/commit/8c4c4ae098825ee0edf2f5f273c1d7352d1f4d18))
* add central catalog source to config layering ([84ee7a1](https://github.com/rpollard00/pi-materia/commit/84ee7a1959145f45ee9fa27f97f2ff6a450b8697))
* add central monitoring read APIs ([5a3ebcf](https://github.com/rpollard00/pi-materia/commit/5a3ebcfa42160dd2e0dd66e395ea4b143d944a8a))
* add central server skeleton ([6262b42](https://github.com/rpollard00/pi-materia/commit/6262b42e9c52b7c02d00a97bdfa1c71dee6a7e60))
* add central telemetry ingestion ([69dbd7a](https://github.com/rpollard00/pi-materia/commit/69dbd7ac2b1334b45adfb4c67d697fd8bb150c6f))
* add control-plane DTO and port contracts ([c80b9bf](https://github.com/rpollard00/pi-materia/commit/c80b9bf14032eaf9e4f91112ace6510ee54e5061))
* add dev-token auth and RBAC middleware ([a775f52](https://github.com/rpollard00/pi-materia/commit/a775f52336a7ad5146631cb2d8bf46d17be9ded8))
* add enterprise scope and principal domain contracts ([dff6a73](https://github.com/rpollard00/pi-materia/commit/dff6a73a6088d4276c6e363cb0c8dc41bcea39c9))
* add explicit central-to-local catalog actions ([899f8fe](https://github.com/rpollard00/pi-materia/commit/899f8feaeedcfc4992fa721c85214bbf098a309a))
* add model policy contracts ([546fd70](https://github.com/rpollard00/pi-materia/commit/546fd70e8a3b9208d60ad6a83d9104d3852008c1))
* add WebUI backend mode discovery ([88244bd](https://github.com/rpollard00/pi-materia/commit/88244bd8c16d43c5d42e4633b70758e91ca5d598))
* enforce model policy during local model selection ([244c80d](https://github.com/rpollard00/pi-materia/commit/244c80d4b31c8fba256e7525a35ff65405ef0a07))
* expose central model catalog and policy APIs ([bc096ef](https://github.com/rpollard00/pi-materia/commit/bc096efb10d2e79df85d711c05e82862d5814c38))
* guard WebUI local-only controls in central mode ([1f835d3](https://github.com/rpollard00/pi-materia/commit/1f835d350c0d0695311b1a8dc6f6a62f0b8c5abb))
* implement local control-plane adapter ([84a3f58](https://github.com/rpollard00/pi-materia/commit/84a3f58a5a2aa8bb7bdd164dffcab5e57589b0a5))


### Bug Fixes

* add eventing environment overlay ([e71225d](https://github.com/rpollard00/pi-materia/commit/e71225d339c8dd6035d866e54bccf1f116c7551b))
* add webhook activation diagnostics ([c73b765](https://github.com/rpollard00/pi-materia/commit/c73b765e2ffd365d059bbc943df73616ae7e7b3f))
* anchor context isolation to the current hidden materia prompt ([ac770d0](https://github.com/rpollard00/pi-materia/commit/ac770d054b9f7215ab833f82ec238c5c8190c796))
* constrain previous-output exposure to canonical handoff payloads ([1d99dce](https://github.com/rpollard00/pi-materia/commit/1d99dce591bbd5bf1b907f45db24b7010bcba06c))
* emit satisfied handoff fields from mime-maintain success outputs ([348efdd](https://github.com/rpollard00/pi-materia/commit/348efdda69757a9ce61a475155cff48c2f9336dc))
* enable agent-controller preset from environment ([0c07152](https://github.com/rpollard00/pi-materia/commit/0c07152a2c213936d51ec61aa728a6b279fdd96f))
* filter materia transition cards from isolated agent context ([0ae6144](https://github.com/rpollard00/pi-materia/commit/0ae614451ecc811eac488d9d15ee8cf8984bd4d0))
* generate socket-scoped handoff contract prose ([a371cc8](https://github.com/rpollard00/pi-materia/commit/a371cc84e230e4d61211ec1b769a21557b5d0ca8))
* guard agent_end handling with active-turn provenance ([3b971ee](https://github.com/rpollard00/pi-materia/commit/3b971eedc313350f76fef3c07f40d7414727fc6d))
* harden bundled JSON materia prompts against text leakage ([ca0ddae](https://github.com/rpollard00/pi-materia/commit/ca0ddae09f11f8655be99407fed2f8badcb0c0f1))
* make renderable text opt-in in socket requirements ([5ffebf9](https://github.com/rpollard00/pi-materia/commit/5ffebf975fd916634f244e7f59922e4b93b5de02))
* merge eventing overlay after normal config load ([4bea3fb](https://github.com/rpollard00/pi-materia/commit/4bea3fb2447c331073b1c95d8dcdfc8a890e7597))
* normalize handled mime-maintain failures as routable JSON ([ebdfd49](https://github.com/rpollard00/pi-materia/commit/ebdfd492fadc3fe955dd379417e67c4af4dc7d4a))
* record real async webhook dispatch outcomes ([ebf97e3](https://github.com/rpollard00/pi-materia/commit/ebf97e3b337d00c0b379ed37e06ef2a22494f47c))
* repair misplaced text payloads on non-text JSON sockets ([55f7f4b](https://github.com/rpollard00/pi-materia/commit/55f7f4b57f7b46fb7f7903874683eedc27d91dbb))
* scope event side-channel examples to socket fields ([661859b](https://github.com/rpollard00/pi-materia/commit/661859b8ca6c7f18dacf18c259eb08ae2174aee5))
* tag materia transition display messages as orchestration-only ([fe5d941](https://github.com/rpollard00/pi-materia/commit/fe5d941610efb37a39e62c5045f826b7aa7179eb))
* test failures ([53ef8f5](https://github.com/rpollard00/pi-materia/commit/53ef8f53a9ff3ea899999a2a6b68f9ccd299a013))
* test failures ([5fb1276](https://github.com/rpollard00/pi-materia/commit/5fb12768a6050f5f61e7948fbcea98a6842266ba))

## [0.1.9](https://github.com/rpollard00/pi-materia/compare/v0.1.8...v0.1.9) (2026-06-18)


### Features

* accumulate result events for final outcome ([27e39ca](https://github.com/rpollard00/pi-materia/commit/27e39ca3f5e5ab4a67aae41f6bd98cf2057b6e69))
* add agent-controller webhook preset ([d2ce7a6](https://github.com/rpollard00/pi-materia/commit/d2ce7a689b4590330bd5ad4adad3552d241a1e21))
* add azure devops PR utilities for jj and git workflows ([8a54e7c](https://github.com/rpollard00/pi-materia/commit/8a54e7cc10f38b4bddc8cbc45ed0b9fee2d25388))
* add blackbelt GitHub pull request utility ([1f6abb9](https://github.com/rpollard00/pi-materia/commit/1f6abb9695113bbc3f3b5472a77266b9e1b9f059))
* add event bus dispatch and local event recording ([6656db8](https://github.com/rpollard00/pi-materia/commit/6656db8b573bcfc8ae1f1e5839b84c541f41e6a7))
* add eventing configuration schema and persistence ([e0dd640](https://github.com/rpollard00/pi-materia/commit/e0dd64062d9ef10190ddebdc5432d2cf1d2e4186))
* add expandable pretty event details ([d343296](https://github.com/rpollard00/pi-materia/commit/d343296e049d3b25aaa0eccefca3600f32784f74))
* add filter and sort controls to materia palette ([d39849c](https://github.com/rpollard00/pi-materia/commit/d39849c1e7ea699b208af7cf396e634cd74cbd03))
* add fixed zoom buttons to the canvas overlay ([57ab3ef](https://github.com/rpollard00/pi-materia/commit/57ab3ef95e9c2471cd1b35eff2de0ee7fb7e932e))
* add fuzzy loadout picker candidates ([a0b426a](https://github.com/rpollard00/pi-materia/commit/a0b426acd87311fc996eb99841cc0f2884a00fec))
* add heartbeat and terminal event handling ([6fbf3f2](https://github.com/rpollard00/pi-materia/commit/6fbf3f21e72067700351bdbc26093248fa0ed58d))
* add internal event model and validation ([5c50512](https://github.com/rpollard00/pi-materia/commit/5c505127c4701f2ed8d6afa48ab8e7333e89f014))
* add mime-bootstrap git branch setup utility ([9b9d37f](https://github.com/rpollard00/pi-materia/commit/9b9d37faa26a7d9d6991262954444e94ca08faa4))
* add mime-maintain git commit utility ([268121c](https://github.com/rpollard00/pi-materia/commit/268121c1268fb5088c6c0667e760e76d9828cc88))
* add mime-pr git push and pull request utility ([f2477a1](https://github.com/rpollard00/pi-materia/commit/f2477a17e7be1ba3a472e9569d4d15d6ed790fd8))
* add raw JSON runtime event mode ([54d19ee](https://github.com/rpollard00/pi-materia/commit/54d19eedf78f999759b4e96ca6c676d3b26856c6))
* add runtime event enrichment and sequencing ([d3aa3d0](https://github.com/rpollard00/pi-materia/commit/d3aa3d05eb6b22940a1b2217fc9cdd768af4641c))
* add runtime events to monitor snapshots ([58cb00d](https://github.com/rpollard00/pi-materia/commit/58cb00db68632de81c321cb8e350df00576b323e))
* add scalable zoom state to the Loadout canvas ([23d48fa](https://github.com/rpollard00/pi-materia/commit/23d48fa296af6741dbf5e077916aec68a63714ae))
* add severity-level filtering to runtime event monitor ([9be63ce](https://github.com/rpollard00/pi-materia/commit/9be63ce8afad43a7f453961d076366d0c15c3f2d))
* add synthetic context for event emission ([dd8bd81](https://github.com/rpollard00/pi-materia/commit/dd8bd81fa0b212d1b0f258a8b471ff595d5a7aaa))
* cover severity filter behavior in monitor tests ([c0cec1c](https://github.com/rpollard00/pi-materia/commit/c0cec1cd79be0ea0cb1dd68591d275822854fcc2))
* derive retry budget for the current TUI step ([c9b4f90](https://github.com/rpollard00/pi-materia/commit/c9b4f905deefe1d3a10a29acae83fb96c7c0413c))
* emit lifecycle events through event bus ([329f38d](https://github.com/rpollard00/pi-materia/commit/329f38d1a179d9309790a4351ee9ed163bd7f7bd))
* enable /materia loadout interactive autocomplete ([e0fb662](https://github.com/rpollard00/pi-materia/commit/e0fb662139dc8a9d8988d1e2f7f4a56633435c06))
* extract shared compact option dropdown ([0c4b3c3](https://github.com/rpollard00/pi-materia/commit/0c4b3c333f5dcb98038f7e4bf932ad3a6b6e9783))
* implement configurable webhook sink delivery ([238ba8c](https://github.com/rpollard00/pi-materia/commit/238ba8ca29f9172c3580f99c9aafeb8cf39219f4))
* process materia event side-channel ([d4bd991](https://github.com/rpollard00/pi-materia/commit/d4bd991f6f86bcea81c7f54b9b088fde8c3c6877))
* register mime utility materia in gallery and defaults ([103051f](https://github.com/rpollard00/pi-materia/commit/103051fed0b0b8317e6dacbd8ba2ced20894c9e3))
* rename github PR utilities to gh-specific names ([97076d0](https://github.com/rpollard00/pi-materia/commit/97076d0b3575c6fcf61f51f5ec50453c1ce11672))
* render pretty runtime event ticker rows ([92d07a5](https://github.com/rpollard00/pi-materia/commit/92d07a587028538be136dcfd8d0fced12445be3c))
* render retry budget in the compact Materia widget ([1c81d4c](https://github.com/rpollard00/pi-materia/commit/1c81d4cd6a748e8711fb066420568718853a5bd2))
* render retry budget in the compact Materia widget ([57ba529](https://github.com/rpollard00/pi-materia/commit/57ba529ba3be366a52a7e73d04edaa6d19a2b2a8))
* replace monitor tab with runtime event monitor shell ([de72fd2](https://github.com/rpollard00/pi-materia/commit/de72fd23fcdb1a99c10a61588bd3bda880601e05))
* replace the native sort dropdown with a compact icon menu ([828ff24](https://github.com/rpollard00/pi-materia/commit/828ff241c973eeeb25b189429587c145c655bd41))
* show fading zoom percentage feedback ([059459a](https://github.com/rpollard00/pi-materia/commit/059459ab16bac37c7195bdaefe9fab4b24645c76))
* strip event before handoff semantics ([e2bd670](https://github.com/rpollard00/pi-materia/commit/e2bd670d1e4d8375d9fe058d8c265d12778cd68a))
* strip event before handoff semantics ([c7835df](https://github.com/rpollard00/pi-materia/commit/c7835dfb49ddaff7704f4cb269c06dbd620c419a))
* support mouse wheel zoom on the canvas ([26faf35](https://github.com/rpollard00/pi-materia/commit/26faf35634db19533e1b1ca61d12830ef1426683))
* update PR utilities to emit result events ([c41e588](https://github.com/rpollard00/pi-materia/commit/c41e5887dee1d7b6c271fdfab8686579008947a8))
* update PR utilities to emit result events ([938d82e](https://github.com/rpollard00/pi-materia/commit/938d82ea85a90946a64c85fb4af844707f56f6c2))


### Bug Fixes

* align palette filter and sort controls on one row ([0705201](https://github.com/rpollard00/pi-materia/commit/07052012221c79d308f1b2d5959e858848f7b849))
* avoid pushing empty blackbelt working commits in the PR utility ([6359c14](https://github.com/rpollard00/pi-materia/commit/6359c14b0fb90a58053cb5ddf6fc34bfd0a9d4f6))
* build webui ([2d8fe6a](https://github.com/rpollard00/pi-materia/commit/2d8fe6a508692a8083cf849a2ce882c9a3d38249))
* capture traversal-limit exhaustion as revivable cast state ([6ae18fd](https://github.com/rpollard00/pi-materia/commit/6ae18fdaa5577c3ddf864f20789cb80bfdb863d9))
* center materia loadout modal on the viewport ([e8dcafe](https://github.com/rpollard00/pi-materia/commit/e8dcafe305a1c17bca9c107849f46ae23224f31d))
* compact and retry same-socket turns on confirmed context overflow ([f40cc4b](https://github.com/rpollard00/pi-materia/commit/f40cc4b3562ffa13750843c9ab7cb9df72c4db6c))
* disable wheel zoom on loadout grid ([8f91a70](https://github.com/rpollard00/pi-materia/commit/8f91a705a79676a03bd13126b9b1c8b1b119787d))
* disable wheel zoom on loadout grid ([3d4446d](https://github.com/rpollard00/pi-materia/commit/3d4446d7fab7d4ea6a32cac16ff4019d8a44e867))
* extend traversal allowance when reviving ([a9cc88f](https://github.com/rpollard00/pi-materia/commit/a9cc88f4b59ff6a77d10378ced619b8f8cb880ca))
* filter orchestration custom messages from isolated materia context ([2b8ba00](https://github.com/rpollard00/pi-materia/commit/2b8ba00d242db68b6b5d1b9ed79d9dd631c78a23))
* harden blackbelt utilities against refused jj snapshots ([867118b](https://github.com/rpollard00/pi-materia/commit/867118bfff9f803b2b92f6502224505261801e48))
* harden blackbelt utilities against refused jj snapshots ([a115345](https://github.com/rpollard00/pi-materia/commit/a1153451454300b582840ecaf7ef136ab66a0593))
* harden monitor SSE connection fallback ([2c2c93e](https://github.com/rpollard00/pi-materia/commit/2c2c93e68e3aafc8b2336f3719a9d13c13ac4132))
* isolate mime missing-git tests from system PATH ([8b820e8](https://github.com/rpollard00/pi-materia/commit/8b820e874549f71c91500d313c1100811f012900))
* isolate mime missing-git tests from system PATH ([51e9e8e](https://github.com/rpollard00/pi-materia/commit/51e9e8ebd271bbb5eaf405cfa1a8d14dce674bb6))
* keep quest runner orchestration messages user-only ([274b4a7](https://github.com/rpollard00/pi-materia/commit/274b4a77f056a171359e3aed93572e0468a85769))
* make loadout grid drag-box pointer coordinates zoom-aware ([78589c7](https://github.com/rpollard00/pi-materia/commit/78589c7a8cc70daf9ba0a33e9786c658e81c9c7e))
* name dirty blackbelt bootstrap revisions before creating a new jj working commit ([3741a2d](https://github.com/rpollard00/pi-materia/commit/3741a2d3f2b8ceac1ecf7a7d9818aadf5463f263))
* new webui artifacts ([aab7765](https://github.com/rpollard00/pi-materia/commit/aab77652f539d93a81c9e11605a49dfbe280a62a))
* normalize legacy monitor event provenance to materia names ([c4f4717](https://github.com/rpollard00/pi-materia/commit/c4f4717f0724c3e07cb630f9c81d6577b23680a3))
* place zoom buttons in graph corner ([e2a070d](https://github.com/rpollard00/pi-materia/commit/e2a070d83d7426126f3eaf4aab496c77f2081f6e))
* place zoom buttons in graph corner ([e7d664a](https://github.com/rpollard00/pi-materia/commit/e7d664a243e7ec11855051b3350ab0429793ef25))
* populate monitor feed in default local casts ([fea98b7](https://github.com/rpollard00/pi-materia/commit/fea98b762c90c703dff6634c74717f58bfd85b98))
* preserve event feed scroll position and add return to latest ([8dcc066](https://github.com/rpollard00/pi-materia/commit/8dcc066cdae2e88cfa612db45e2fbe3205a5465c))
* preserve event feed scroll position and add return to latest ([0815538](https://github.com/rpollard00/pi-materia/commit/08155386aaedcab7cc9008e0997831fff95731ab))
* preserve quest log draft state across tab switches ([d855918](https://github.com/rpollard00/pi-materia/commit/d855918f1068eae88e329d36d5eebf7d31312d69))
* recognize explicit request-over-context errors as confirmed overflow ([339a6e5](https://github.com/rpollard00/pi-materia/commit/339a6e5576750f9b3a552df56d8860e314ee3532))
* remove duplicated compact monitor event body text ([80f94f5](https://github.com/rpollard00/pi-materia/commit/80f94f5548f8e4100f902432e197f59817799ef5))
* report unpushable unnamed non-empty blackbelt commits before GitHub PR creation ([cc3cd72](https://github.com/rpollard00/pi-materia/commit/cc3cd72640a45e401f13a77b4ca784138ae622e3))
* reset quest log draft only on explicit completion or context change ([81d4d5f](https://github.com/rpollard00/pi-materia/commit/81d4d5f4a9ed5f4bef3b3b343701300dbd9d0e7d))
* resume revived edge-limit casts from the blocked target ([78534af](https://github.com/rpollard00/pi-materia/commit/78534af2493ae9ef0089747cbcfce2ac3a334b29))
* show complete loadout catalog for /materia loadout ([4d7c74f](https://github.com/rpollard00/pi-materia/commit/4d7c74fe22861478d4dee7f6395129c2b456ef8e))
* show complete loadout catalog for /materia loadout ([7cd8e98](https://github.com/rpollard00/pi-materia/commit/7cd8e98b22b4ef4e74e2ec55843d2d87c1a2d9c1))
* stabilize the loadout materia palette height and scrolling ([5ca369a](https://github.com/rpollard00/pi-materia/commit/5ca369a029f8b0d42678df9ab2b3059eed2fcd6f))
* suppress proactive compaction immediately after model switches ([1712ade](https://github.com/rpollard00/pi-materia/commit/1712ade0873c4ae44213f407882848712b420bd7))
* synchronize materia saves with live WebUI config state ([8a8ceb4](https://github.com/rpollard00/pi-materia/commit/8a8ceb4544f6d0cd4e247c2791fb49217d20beac))
* trigger proactive compaction using projected Materia request size ([166f91f](https://github.com/rpollard00/pi-materia/commit/166f91fc37d1b47329d4351cc364c5caf181b4c6))
* trigger proactive compaction using projected Materia request size ([5ada0a1](https://github.com/rpollard00/pi-materia/commit/5ada0a133176df226211284c71acaa6b7a92d638))

## [0.1.8](https://github.com/rpollard00/pi-materia/compare/v0.1.7...v0.1.8) (2026-06-06)


### Features

* add deterministic jj bookmark naming for blackbelt ([7c5802c](https://github.com/rpollard00/pi-materia/commit/7c5802c231eb80371b6cae2a05e7ecefb2a06fa0))
* update blackbelt-bootstrap to create jj bookmark ([4293e5a](https://github.com/rpollard00/pi-materia/commit/4293e5af3c862e11e3f81ffb3defe1d1503dc4f6))


### Bug Fixes

* classify stream-ended agent transport errors before terminal failure ([dd4c0ef](https://github.com/rpollard00/pi-materia/commit/dd4c0ef0800e8cbbeb3d5842b40fec60019e0ff3))
* generate noun-verb blackbelt bookmark names ([5c5061a](https://github.com/rpollard00/pi-materia/commit/5c5061ab35d1a58b9fbb5fbc83c4a6ef32b73a00))
* generator socket configuration boundary ([4ec1b90](https://github.com/rpollard00/pi-materia/commit/4ec1b90293f3e1f94a667cb6c85dfe7e72544855))
* make Commit-Sigil emit canonical generator output ([47949fe](https://github.com/rpollard00/pi-materia/commit/47949feca1a9efefaa25633311a856598a0c9663))
* **materia:** preserve active loadout when opening UI ([41b3d4d](https://github.com/rpollard00/pi-materia/commit/41b3d4d83d5f9ad7d834ade06297df5bec05f608))
* preserve active cast state for recoverable stream failures ([21f5927](https://github.com/rpollard00/pi-materia/commit/21f592715cd3e0d06193aa90435e20da04e1ec60))
* restore npm typecheck success ([2dc5711](https://github.com/rpollard00/pi-materia/commit/2dc5711d2c36b57678ae5240e837a6f93f349a4a))
* treat generator utilities as workItems producers ([c403676](https://github.com/rpollard00/pi-materia/commit/c403676664f1a2cd694faeaed3c3850677e27bcc))

## [0.1.7](https://github.com/rpollard00/pi-materia/compare/v0.1.6...v0.1.7) (2026-06-02)


### Features

* Add Blackbelt-Bootstrap deterministic utility script ([11e62c6](https://github.com/rpollard00/pi-materia/commit/11e62c6799d6fff0835ed39607a1861d97bb5935))
* Register Blackbelt-Bootstrap as a shipped palette utility ([fc4bd5a](https://github.com/rpollard00/pi-materia/commit/fc4bd5a31f2a052e396adea4d4749f2ccb5a149e))

## [0.1.6](https://github.com/rpollard00/pi-materia/compare/v0.1.5...v0.1.6) (2026-06-02)


### Features

* **materia-revive:** add timeout revive integration tests with metadata and hint preservation ([f213485](https://github.com/rpollard00/pi-materia/commit/f21348514dc9c41562cba2d4cf433b0f58779d7b))
* **materia-runtime:** add timeout-specific same-socket retry budget ([f92271f](https://github.com/rpollard00/pi-materia/commit/f92271f5ca404346e11b28335485539c8769e24a))
* **materia-runtime:** persist timeout recovery hints across retries ([0715cf4](https://github.com/rpollard00/pi-materia/commit/0715cf4ac617e258ddd899355f72d1363f2c5502))
* refine the default prompts ([1a3f634](https://github.com/rpollard00/pi-materia/commit/1a3f6341ff6eb76aea2531c700c4076d3bcdf73f))


### Bug Fixes

* **materia-runtime:** classify bash tool timeouts as recoverable failures ([e38f2e9](https://github.com/rpollard00/pi-materia/commit/e38f2e97251fa0e0d5b1982b3d3cb68a1711b7b6))
* test failures ([9ada6f1](https://github.com/rpollard00/pi-materia/commit/9ada6f1ceb959d5e1d16c9d3842bc4de94a73af5))
* untrack pi artifact ([72cbd7a](https://github.com/rpollard00/pi-materia/commit/72cbd7a94506ddf800afdfbb8e0822c80e29db62))

## [0.1.5](https://github.com/rpollard00/pi-materia/compare/v0.1.4...v0.1.5) (2026-05-28)


### Bug Fixes

* repository url in package ([e8ab67a](https://github.com/rpollard00/pi-materia/commit/e8ab67a0cd56b5532bcaeb8287888be3ad8fed57))

## [0.1.4](https://github.com/rpollard00/pi-materia/compare/v0.1.3...v0.1.4) (2026-05-28)


### Bug Fixes

* trigger npm trusted publishing retry ([8ed5b4d](https://github.com/rpollard00/pi-materia/commit/8ed5b4d0d9bbd6b624cfb11a97ab02bcd929f069))

## [0.1.3](https://github.com/rpollard00/pi-materia/compare/v0.1.2...v0.1.3) (2026-05-28)


### Features

* add autocast use case and virtual loadout wiring ([997f1d6](https://github.com/rpollard00/pi-materia/commit/997f1d6e0a57f1ee2ac24c3b0d461b72353c164c))
* add cast-start prompt dispatch policy ([a7e90d9](https://github.com/rpollard00/pi-materia/commit/a7e90d9c7cccc12aab3537dfafdeefba085b818e))
* add Commit-Sigil work item title validator ([6299f4f](https://github.com/rpollard00/pi-materia/commit/6299f4f6451123d2ac49b6e72ec79e38dfc01579))
* add JSON output repair retry prompt ([772bd71](https://github.com/rpollard00/pi-materia/commit/772bd715ac909ea549b803a2625734d3e5fef929))
* add materia selector color orbs ([3b76e96](https://github.com/rpollard00/pi-materia/commit/3b76e966be9b4030b828852a56637f773cc214dd))
* add per-cast loadout override ([51e5e9e](https://github.com/rpollard00/pi-materia/commit/51e5e9e3a5a001b4b4bbee102de40e39de0939ed))
* add quest board domain model ([f90b9ce](https://github.com/rpollard00/pi-materia/commit/f90b9cecd5d3a1c1bc56bf5016bd4f7719f346d4))
* add quest board file repository ([5ae9d72](https://github.com/rpollard00/pi-materia/commit/5ae9d7245eb216a24ba3d5272a7fa30df7aeadf4))
* add quest default loadout API ([99706b0](https://github.com/rpollard00/pi-materia/commit/99706b0ad335c9bdc7db11c45be3f9c28d75bd52))
* add quest detail requeue action ([f9fe888](https://github.com/rpollard00/pi-materia/commit/f9fe88895c29f358e188e56609416db42657b308))
* add quest requeue cli support ([121d77c](https://github.com/rpollard00/pi-materia/commit/121d77ca3ac620319d9dd31af41ae6f4657cccf6))
* add quest requeue domain transition ([abe2188](https://github.com/rpollard00/pi-materia/commit/abe21882315195d2b19fea5b2a09ce6fa484eb02))
* add webui quest drag reorder ([2b2f2eb](https://github.com/rpollard00/pi-materia/commit/2b2f2eb8872cfd6fffbc65234c1313ca45af0fea))
* add webui quest requeue api ([935eec2](https://github.com/rpollard00/pi-materia/commit/935eec237ad2b16dce3ff684db22bc6e5af6c9e1))
* add webui requeue hook support ([2ffaa92](https://github.com/rpollard00/pi-materia/commit/2ffaa92cde3a939bbc3aac6bc6a523cf58099d0d))
* canonicalize utility materia references ([bbb7a03](https://github.com/rpollard00/pi-materia/commit/bbb7a036a731516c3486d0ee6a42102fbbd90c4c))
* checkpoint materia editor policy controls ([81c363b](https://github.com/rpollard00/pi-materia/commit/81c363ba3de4edba80e4c9bd6be830f7cfe953e1))
* externalize utility scripts ([82114de](https://github.com/rpollard00/pi-materia/commit/82114deb36c0867887a6b25736597bfd7bb1dcd6))
* finalize utility materia webui handling ([461a150](https://github.com/rpollard00/pi-materia/commit/461a1500adf4e3cf324b0ab9da2e128e52ae6f6b))
* improve quest move id references ([f248af2](https://github.com/rpollard00/pi-materia/commit/f248af254f6283b641f75d8546a9d11b2a06df27))
* **loadout:** migrate selector lock/read-only icons to Lucide SVG ([5b23213](https://github.com/rpollard00/pi-materia/commit/5b23213f209b9d4dbb9a5f3efe74d7d7fdbf23a2))
* open loop controls from cycle target ([a59cf28](https://github.com/rpollard00/pi-materia/commit/a59cf28fe08127a668eb9a8cbbde86c9bec7ae17))
* persist generation model preference ([6c97d46](https://github.com/rpollard00/pi-materia/commit/6c97d46489d0c554f6b84dd5e24d31b8c69f64a4))
* prefer conventional commit work item titles ([34057fc](https://github.com/rpollard00/pi-materia/commit/34057fc457f443ef59690e2a04334e7e8f5820a7))
* quest card id and summary label ([9f7eb85](https://github.com/rpollard00/pi-materia/commit/9f7eb85b1d9229f2ce061a0115da383c9de73219))
* quest launch loadout resolution ([5fa2984](https://github.com/rpollard00/pi-materia/commit/5fa29844c3298c39ba3bef5a020eac0e473f2c74))
* refine quest cast attribution in cli ([184ab20](https://github.com/rpollard00/pi-materia/commit/184ab20559284eaf9deb2d23a5b0e4648dd2107b))
* resolve utility sockets via materia ([3daa898](https://github.com/rpollard00/pi-materia/commit/3daa898f38ddabd4c8bf9fdeb06683162c6ba143))
* separate quest default loadout preference ([ff5588d](https://github.com/rpollard00/pi-materia/commit/ff5588d540bc067a077f9ee057a30861b77ef6b1))
* show completion cast in quest web ui ([4d4bb63](https://github.com/rpollard00/pi-materia/commit/4d4bb6311d00da2ee9a9053242655f31532c6002))
* thread quest default loadout props to quests tab ([ea3aeaa](https://github.com/rpollard00/pi-materia/commit/ea3aeaad3f24d639110989394334660d2d945e0e))
* utility generator handoff normalization ([a58df34](https://github.com/rpollard00/pi-materia/commit/a58df34301e208c68c9ffcc0ca5535f1a09eaab9))


### Bug Fixes

* append requeued quest to queue bottom ([12af090](https://github.com/rpollard00/pi-materia/commit/12af090adf6319a2db10a2599fd1c28c13769d58))
* defer agent-end quest auto-advance dispatch ([55b2382](https://github.com/rpollard00/pi-materia/commit/55b23828f7a59f872323e09f423773960dcd4ce7))
* defer next socket prompt dispatch ([9a68251](https://github.com/rpollard00/pi-materia/commit/9a68251add3e8bfb853a0b6ad3033c29a432d9e7))
* make quest add enqueue-only in CLI ([57bbe94](https://github.com/rpollard00/pi-materia/commit/57bbe94bc4cf7a6ac58132b34beb395995901e51))
* resolve default loadout preference by display-name or stable id ([61bb98a](https://github.com/rpollard00/pi-materia/commit/61bb98a2add29aab03ef0d3b58fee93a4d38fc21))
* separate reciprocal edge lanes ([4002239](https://github.com/rpollard00/pi-materia/commit/4002239a12ecfc9def072d5a20641903ac3cd575))
* sync loop modal selection with loadout changes ([1a34422](https://github.com/rpollard00/pi-materia/commit/1a3442294a969736903e2c5baee872cf4102c3ef))
* sync native lifecycle transitions ([9ab9ca3](https://github.com/rpollard00/pi-materia/commit/9ab9ca3f187dd8f34cb5e9b1fa20703c4abe06b9))
* **WI-3:** remap linked loadout loop metadata ([335b617](https://github.com/rpollard00/pi-materia/commit/335b6177e8fd0886f29bbdc1f8b5bb66bc2029ae))
