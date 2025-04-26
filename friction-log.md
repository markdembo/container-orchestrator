- SQL backed DOs:
Not sure why this blob is needed:
```
{
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": [
        "MyDurableObject"
      ]
    }
  ]
}```
- Warning in terminal: `Your types might be out of date. Re-run `wrangler types` to ensure your types are correct.`
I think this should be npx wrangler types
- Plain vanilla project tells me stuff is out of date - means template is out of date?