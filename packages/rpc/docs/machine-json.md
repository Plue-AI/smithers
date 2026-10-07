---
title: "Machine image proposals"
description: "Validated package additions to machine.json."
---

`MACHINE_JSON_PATH` names `.smithers/machine.json`; `IMAGE_PACKAGE_PATTERN` validates Debian package names. `addImagePackage` preserves order and returns the proposed JSON and a diff for that file only. It performs no disk writes.

`MachineJsonRejected` distinguishes `invalid_name`, `invalid_json`, `invalid_document`, `invalid_packages`, `duplicate_package` and `package_limit`. Only the packages field is accepted, duplicate JSON keys are rejected, and at most 64 packages may be declared.
