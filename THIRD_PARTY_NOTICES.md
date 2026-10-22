# Third-party notices

Agent Workbench code is licensed under MIT. The following components retain their own licenses and trademark rights.

| Component | Source and license |
| --- | --- |
| Archify 3.2.0 | https://github.com/tt-a1i/archify — MIT for its code; see vendor/archify/LICENSE and THIRD_PARTY_NOTICES.md |
| Lobe Icons | https://github.com/lobehub/lobe-icons — MIT; full text in licenses/lobe-icons-MIT.txt; pinned icon provenance in licenses/agent-icons.json |
| GitHub Copilot icon | https://github.com/primer/octicons — MIT; licenses/primer-octicons-MIT.txt |
| Electron | https://github.com/electron/electron — MIT and bundled Chromium/third-party terms; binary package includes LICENSE and LICENSES.chromium.html |
| Node.js | https://nodejs.org — MIT and third-party terms; Windows package includes licenses/Node-LICENSE.txt |
| Token Monitor Hub 0.70.0 | https://github.com/Javis603/token-monitor — MIT; unmodified minimum dependency closure, LICENSE and pinned checksums in vendor/token-monitor |
| npm dependencies | Versions and registry integrity hashes in package-lock.json; each dependency retains its installed license |

The public edition uses MIT-licensed icon artwork where available, including Zhipu (GLM) from Lobe Icons. Bolt, Lingma and Zcode use official website brand assets; Grok Bot uses the brand mark distributed by ASVG. Their source URLs and hashes are recorded in licenses/agent-icons.json. These four brand assets are included for software identification; copyright and trademark rights remain with their owners, and no MIT license or general redistribution grant is asserted for them. Check the owners' terms for other uses or redistribution. No affiliation or endorsement is claimed.

Archify includes brand-mark metadata with individual CC-BY, CC-BY-SA and CC-BY-NC-SA terms. Those assets are **not** relicensed as MIT. The upstream attribution, source links and limitations are preserved in vendor/archify/THIRD_PARTY_NOTICES.md and renderers/shared/generated-brand-marks.mjs. Verify applicable terms for commercial redistribution or authored diagrams using these marks. JetBrains Mono uses SIL OFL 1.1; Pele uses MIT; their complete texts are retained in the vendor tree.

Token Monitor's desktop collector and all user data are excluded. Only the pinned Hub source is bundled. The wrapper uses createHub directly; the upstream standalone CLI's optional dotenv dependency is not used. Optional AgentsView provisioning retrieves its original release and preserves its notices; its own terms apply.
