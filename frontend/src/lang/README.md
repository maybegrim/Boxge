# Translations

A short guide on how to translate Boxge into your language.

## How to translate

1. Find your language file in `frontend/src/lang/` (for example `de.json`). Each file maps
   string keys to their translated values.
2. If your language does not have a file yet, copy `en.json` to `<code>.json` (for example
   `fr.json`) and translate the values. Leave the keys unchanged.
3. Add your language to `languageList` in `frontend/src/i18n.ts`, for example:
   `"zh-TW": "繁體中文 (台灣)"`.
4. Open a pull request against https://github.com/maybegrim/Boxge.
