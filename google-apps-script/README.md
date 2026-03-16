# Google Sheets sync

## Co spravit

1. V Google Drive vytvor novu tabulku.
2. Z URL tabulky skopiruj `spreadsheetId`.
3. Otvor `Extensions > Apps Script`.
4. Do `Code.gs` vloz obsah zo suboru [Code.gs](C:\Users\domis\Desktop\apps\nakupny zoznam\google-apps-script\Code.gs).
5. V `SPREADSHEET_ID` nastav svoje ID tabulky.
6. Klikni `Deploy > New deployment`.
7. Typ vyber `Web app`.
8. `Execute as`: `Me`.
9. `Who has access`: `Anyone`.
10. Deployni a skopiruj `Web app URL`.
11. Tu URL vloz do [index.html](C:\Users\domis\Desktop\apps\nakupny zoznam\index.html) do `SHEETS_SYNC_URL`.

## Co backend podporuje

- `GET ?action=get`
- `GET ?action=load`
- `POST { "action": "get" }`
- `POST { "action": "load" }`
- `POST { "action": "sync", "items": [...] }`

## Format polozky

```json
{
  "id": "abc",
  "name": "Mlieko",
  "qty": "",
  "bought": false,
  "boughtAt": null,
  "updatedAt": "2026-03-16T10:00:00.000Z",
  "deleted": false
}
```

## Poznamka

- Hlavny harok `NakupnyZoznam` obsahuje len aktivne polozky.
- Zmazane polozky sa drzia v skrytom harku `NakupnyZoznam_deleted`, aby fungoval sync medzi zariadeniami.
