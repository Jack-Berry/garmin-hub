# APNs key

Place the Apple push notification key at `deploy/droplet/secrets/AuthKey.p8`.
The key is mounted read-only at `/run/secrets/AuthKey.p8` and is ignored by Git.
Never commit or paste the key into an environment file.
