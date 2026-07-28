# Security Policy

Report vulnerabilities privately to the maintainers. Do not include live
credentials or configuration.

OpenMoat treats configuration, tool metadata, MCP output, and caller identity
as untrusted input. Policy is deny-by-default, deny rules take precedence,
quarantined servers cannot spawn, child commands are passed without shell
interpolation, secret placeholders are resolved only at runtime, and shutdown
reaps pooled children.

Never place secrets directly in `Moatfile`. Use `${NAME}` and provide the value
through the environment or a mode-0600 ignored `secrets.env`.

