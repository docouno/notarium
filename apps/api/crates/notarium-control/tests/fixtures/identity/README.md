# Public identity protocol fixtures

These certificates and signing keys are deliberately public test data. They are
never used by runtime configuration or loaded outside `cfg(test)` code. The CA
private key was discarded after generating the server certificate. Certificates
cover `identity.example.invalid` and have a fixed 2020–2050 validity interval.

The offline HTTPS fixture performs real TLS hostname/signature verification and
HTTP exchanges. Its test-only route allows exactly its origin to reach loopback;
it does not qualify public destination policy. Production policy is tested
separately without that route. No trust bypass exists in production builds.

The RSA keys exercise signing-key rotation with distinct key material. The ES256
vectors were signed independently with Python cryptography (P-256/SHA-256),
including invalid-claim and forbidden-header variants. Verification tests use
the checked-in public JWK and compact signatures; they do not need Python or the
ES256 private key.

The native token vectors use fixed public secrets and independent Python hashlib
SHA-256 digests. Import tests preserve those digests and stored expiries, then
exercise authentication and refresh rotation through the regular services.
