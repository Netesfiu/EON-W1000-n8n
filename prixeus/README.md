# Áttekintés

Nem nagyon tetszett az n8n igénye, így gondoltam a workflow alapján ChatGPT-vel átírattam Golang-ra.
Természetesen javítani is kellett több helyen, de a go code nagyja még mindig LLM-el készült.
Nem azért készítettem így, mert nem értek hozzá, hanem azért, mert ki akartam próbálni, hogy mennyire (fel)használható, amit csinál.
Scratch container, szóval tényleg csak az van ott aminek benne kell lennie a minimális működéshez.

## Telepítés

  1) állítsd be ugyan azokat, mint ami az eredeti megoldáshoz kell: HA token, IMAP, CA chain a HA-hoz, ha kell
  2) build: docker build . -t w1000-go
  3) töltsd ki a w1000.yaml-t
  3) test.sh alapján emeld be a projektedbe (SSL_CERT_FILE akkor kell, ha a HA csak TLS-t fogad)

## PROFIT
