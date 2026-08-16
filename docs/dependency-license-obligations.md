# Dependency license obligations

Zedbee's release license inventory is exact-version and fail-closed. Most
dependencies use permissive licenses. Two production dependencies require
additional reviewed notices:

- `axe-core@4.13.0` is MPL-2.0. Zedbee distributes it unmodified and preserves
  the exact upstream source link. MPL's file-level terms apply to covered
  axe-core files; they do not relicense Zedbee's separately licensed code.
- `caniuse-lite@1.0.30001809` is CC-BY-4.0. Notices preserve the creator and
  material attribution, source and license links, and record that no changes
  were made.

Release verification rejects either dependency when its exact reviewed
obligation record is missing or stale. This compliance record is engineering
documentation, not legal advice.
