# APNs key

Place the Apple push notification key at `deploy/droplet/secrets/AuthKey.p8`,
then run `chown 65532:65532 deploy/droplet/secrets/AuthKey.p8` and
`chmod 400 deploy/droplet/secrets/AuthKey.p8`. The secrets directory is mounted
read-only and the key appears at `/run/secrets/AuthKey.p8`; it is ignored by Git.
Never commit or paste the key into an environment file.
