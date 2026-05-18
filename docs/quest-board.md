# Quest board

The quest board is stored per project at `.pi/pi-materia/quest-board.json`. It is intentionally outside timestamped cast artifact directories so future `/materia quest` commands can inspect and update one stable queue across casts and loadouts.

The first file-backed repository creates `.pi/pi-materia/` and an empty board when the file is absent. Existing files are parsed and validated before use; malformed or schema-invalid JSON is reported with the file path and validation paths and is not overwritten implicitly.

Writes use a temporary file in the same directory followed by rename. This is atomic-enough for the initial vertical slice, but there is no inter-process lock: run only one Pi session that writes a project's quest board at a time. Concurrent sessions may race and the last rename may win.
