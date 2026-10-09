# Changelog

## 0.1.0 (2026-10-09)


### Features

* enable the plugin when it is installed ([968211e](https://github.com/dirkwa/signalk-timezero-sync/commit/968211e800f7674e24185956d8009f8b35bd9ee2))
* log TimeZero's sync rounds and reads in debug output ([3524223](https://github.com/dirkwa/signalk-timezero-sync/commit/35242239b0363112d504a651fdcb42fae6ed1f93))
* **peer:** join TimeZero's sync as a peer ([8ffb2f0](https://github.com/dirkwa/signalk-timezero-sync/commit/8ffb2f06597e56489dfe668f3bab63db0afd644c))
* **protocol:** add TimeZero LAN sync wire formats ([0a50bb4](https://github.com/dirkwa/signalk-timezero-sync/commit/0a50bb48321f197d978333d53e3bc777fb4be33b))
* sync areas and man overboard, and keep TimeZero's locks ([aec26c5](https://github.com/dirkwa/signalk-timezero-sync/commit/aec26c5a14c0d0450e0c864f6c7b35113247578d))
* sync routes, waypoints, navigation and the anchor watch ([7a786f9](https://github.com/dirkwa/signalk-timezero-sync/commit/7a786f936c849287b139577a169a144d48ea6080))


### Bug Fixes

* confirm an offer from TimeZero's copy when TimeZero does not send it back ([c09671d](https://github.com/dirkwa/signalk-timezero-sync/commit/c09671d5dea38083652300663903a2c861acf7b1))
* **course:** compare route GUIDs case-insensitively when following a route ([790dcaf](https://github.com/dirkwa/signalk-timezero-sync/commit/790dcafd9ccc30ed35d6a6a61fe831431045f7a2))
* **course:** drop a waiting route activation when the course changes ([63abd1f](https://github.com/dirkwa/signalk-timezero-sync/commit/63abd1f6a71c10241ecba157b8e6e8cdd109b21f))
* hold back Signal K routes with more than 500 points ([b20f421](https://github.com/dirkwa/signalk-timezero-sync/commit/b20f421572af05c1b5da990323e99af5d82f9f12))
* make first contact and start-up safe for TimeZero's data ([0baf7b9](https://github.com/dirkwa/signalk-timezero-sync/commit/0baf7b93572f9e48e1e331ddeab7da7a8b52728e))
* read TimeZero's table again when a kind is synced for the first time ([a3b5a06](https://github.com/dirkwa/signalk-timezero-sync/commit/a3b5a0662ca48d5697989301def24f3f4cfc5d48))
* read TimeZero's table again when the resource record is behind ([8c00272](https://github.com/dirkwa/signalk-timezero-sync/commit/8c00272d896431f305557421db0e8c1003310927))
* **resources:** keep route-limit reservations safe across restarts and races ([4e17490](https://github.com/dirkwa/signalk-timezero-sync/commit/4e1749050a5a06625c446ff0b772afc6bc886759))
* **resources:** respect TimeZero's 200-route limit ([173ceb8](https://github.com/dirkwa/signalk-timezero-sync/commit/173ceb883722a873050cb7e4b9848b6d43e3a846))
* start TimeZero's sync round by claiming the master role ([85ba4b8](https://github.com/dirkwa/signalk-timezero-sync/commit/85ba4b8341bf9c7f1f0115fc0f5035492e038b65))
