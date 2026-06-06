# Changelog

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
