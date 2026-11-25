# Changelog

## [0.3.0](https://github.com/codehausau/ask/compare/ask-tui-v0.2.0...ask-tui-v0.3.0) (2026-11-25)


### ⚠ BREAKING CHANGES

* .env files are no longer read, from the working directory or the install location. Put settings in ~/.config/ask/ask.json(c) (see ask.example.jsonc), or export the variables. --temperature must be 0-2 and --max-tokens a positive integer.

### Features

* add context-preserving clear commands and refine TUI edit review ([92b6ef5](https://github.com/codehausau/ask/commit/92b6ef59db5fba1d1be288f9e12d89346387ebd9))
* AGENTS.md and instructions files in the system prompt ([fdb0522](https://github.com/codehausau/ask/commit/fdb0522649f3d8aefa41b047b724f43ef594fcc1))
* JSON Schemas for config and theme files ([3048bd8](https://github.com/codehausau/ask/commit/3048bd84ead0ceb1f023f82d6d90483be2646d34))
* layered JSON configuration with project trust ([e000b8f](https://github.com/codehausau/ask/commit/e000b8f000a6e7452eea61820fa1bbd2a34396f0))
* publish the TUI separately as @codehaus-au/ask-tui ([4a47fad](https://github.com/codehausau/ask/commit/4a47fad9cb1a8117741d2305c5f34e29df5efe23))
* save chosen themes; session TTL and spinner in cli.json ([76e275e](https://github.com/codehausau/ask/commit/76e275e387854b4cb2f8daa3518b2d0ba830e524))
* skills from --config directories ([3b6eec7](https://github.com/codehausau/ask/commit/3b6eec7a5e6ee587eadf4b7aff47bc4795c6a474))
* **tui:** add styled update panels with toggleable diff views ([ffb882c](https://github.com/codehausau/ask/commit/ffb882c7ec2eb5b507231888e7c453f4780e17b4))
* **tui:** custom themes from config directories ([4965479](https://github.com/codehausau/ask/commit/49654799fd12f10421bba51659a42559602fc6e2))
* **tui:** highlight selected popup items with theme colors ([77251dc](https://github.com/codehausau/ask/commit/77251dcacbb74e77a39b3bf5a23c79d8edd6a6ac))


### Bug Fixes

* address CodeQL findings in config and theme loading ([cbc24d2](https://github.com/codehausau/ask/commit/cbc24d23331fbc4f4adfd73c46c9adec72836788))
* align retry policies and protect configuration credentials ([8f8bd2c](https://github.com/codehausau/ask/commit/8f8bd2c5c1c5fcea71d6e89d861a0a56d64ff149))
* **config:** reject repository-relative environment paths ([c6c7859](https://github.com/codehausau/ask/commit/c6c7859b8e2e85f36788a86611b927f505d1adc3))
* defer TUI file indexing until picker opens ([08ddfdd](https://github.com/codehausau/ask/commit/08ddfddb7f4f4bd9057d70c087c9f69b30ad5626))
* harden TUI edit review, mentions and Bun lookup ([2253e43](https://github.com/codehausau/ask/commit/2253e43dc52e3a0a5b205ad49c7dd39bc0bc0ed4))
* scope settings loading to the active interface ([3417e9f](https://github.com/codehausau/ask/commit/3417e9f4d3ea82b771c60accba81051c7b4c9a3d))
* target scrollbar track in TUI mouse test ([9ed4e7b](https://github.com/codehausau/ask/commit/9ed4e7b5ceb7ddb9a085eae7a519208ac5306084))
* **tests:** isolate package-manager invocations from HOME and PATH changes ([18542a5](https://github.com/codehausau/ask/commit/18542a55cab5ecaf2ebf254132ff64d0d7f462b3))
* **tui:** reject repository-supplied Bun executables ([5864273](https://github.com/codehausau/ask/commit/58642736aa47a28a62d595573ecdb1af3f95a5be))
* wait for review confirmation in packaged TUI smoke test ([3ff8c7c](https://github.com/codehausau/ask/commit/3ff8c7cabb45ab4b14da9e8d89b93cd517b44401))
