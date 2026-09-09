# Licensing and Commercial Use

Zedbee's source and core npm package use the PolyForm Small Business License 1.0.0. The complete controlling terms are in [`LICENSE`](../LICENSE). This guide explains the package layout; it is not legal advice and does not replace review by qualified counsel.

## Zedbee license

PolyForm Small Business is source-available, not an OSI-approved open-source license. Its permitted purposes and small-business conditions are defined by the license itself. A user whose use falls outside those permissions needs separate terms from the Zedbee licensor. The project owner may offer a separate commercial license without relicensing third-party components.

The package license identifier is `PolyForm-Small-Business-1.0.0`, and the packed core includes the full PolyForm terms. Third-party licenses do not replace the license for Zedbee's own code.

## Requesting a commercial license

To discuss use outside the PolyForm Small Business permissions, email [licensing@zedbee.dev](mailto:licensing@zedbee.dev). In the initial message, include your name, organization, a short description of the intended use, whether Zedbee will be used internally or distributed, and an approximate organization size. Do not send proprietary source code, credentials, or other sensitive material.

The project owner will confirm whether separate terms are needed and explain the next steps. Sending an inquiry does not change the license that currently applies.

## Analyzer libraries and npm dependencies

Third-party npm packages keep their own licenses. In particular:

- Secretlint 13.0.5 and its recommended preset are installed as npm dependencies under MIT terms.
- The lockfile parsers and other analyzer dependencies retain the exact licenses recorded in `licenses/production-inventory.json` and `THIRD_PARTY_NOTICES.md`.

Zedbee does not redistribute Gitleaks or OSV-Scanner executables. The bounded OSV API client is Zedbee's own code and is covered by Zedbee's PolyForm Small Business terms; the remote OSV service is contacted but not distributed. The core package ships its reviewed production dependency inventory and third-party notices.

Zedbee's production dependency gate rejects unknown or unapproved license expressions. It accepts reviewed permissive terms and reviewed exceptions, including MPL-2.0 for the unmodified axe-core dependency. Those exceptions retain their separate obligations; see [dependency license obligations](dependency-license-obligations.md). This engineering control reduces accidental license drift but is not a legal opinion.
