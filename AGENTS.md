# Project Agent Notes

## Encoding And Chinese Text

- Many project files contain Chinese UI text, comments, or legacy strings.
- PowerShell may display Chinese text as mojibake. Do not assume the file is broken just because terminal output looks garbled.
- If garbled Chinese appears only in comments, documentation text, labels, or non-critical display copy, ignore it unless the user explicitly asks to fix text.
- Only modify garbled text when it clearly breaks code syntax, HTML structure, JavaScript strings, JSON, manifest data, or runtime behavior.
- Avoid broad whole-file rewrites such as `Get-Content | Set-Content` on files containing Chinese text.
- Prefer narrow patches for code changes.
- For new helper scripts, comments, and internal test UI, prefer ASCII English text unless Chinese display text is specifically required.
- Before changing encoding-related text, verify whether the issue is only terminal display or actual file corruption.
