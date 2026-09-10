# Commerce intent preservation

Candidate-only decision: retain bounded options, combo flavor IDs (including
catalog-permitted repeats), and stable store reference through quote creation.
These are customer intent, not pricing, availability or fulfillment authority.
The immutable quote records `commerceIntent` for subsequent trusted draft recovery.
Client prices and eligibility remain discarded. Changed selections conflict on
the same request key. Absent new fields preserve the original fingerprint bytes,
including property order, so earlier candidate quotes can still be retried.

Evidence: input tests 4/4; native PostgreSQL checkout 14/14; production build PASS.
Independent review identified the fingerprint compatibility issue; corrected and
covered by a byte-equivalence regression. No production changes or migration.

Remaining integration: server catalog must validate choices and resolve distinct
option/combo variants to stable SKU identities; finance rejects duplicate SKU
lines. Validate store/address ownership and fulfillment before draft creation.
No HTTP route is enabled by this change. This is not checkout end-to-end PASS.
