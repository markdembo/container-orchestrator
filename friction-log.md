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
- "Wrong number of parameter bindings for SQL query."
Need to destruct array - no example in docs; AI got this wrong and I did not spot in docs