# Choir Voice Mixer

Aplikacja do nauki partii chóralnych — odtwarzacz wielościeżkowy z regulacją głośności poszczególnych głosów.

## Struktura projektu

```
.
├── index.html         # Aplikacja (NIE MODYFIKUJEMY przy dodawaniu utworów)
├── songs.json         # Konfiguracja utworów (TUTAJ dodajemy nowe pozycje)
└── audio/
    ├── lion/          # Pliki mp3 dla utworu "lion"
    ├── lollipop/
    ├── django/
    └── <nowy_utwor>/  # Pliki mp3 dla nowego utworu
```

## Jak dodać nowy utwór

**Procedura jest deterministyczna — nie ma miejsca na kreatywność.**

### Krok 1: Pliki mp3

Pliki mp3 dla nowego utworu znajdują się już w katalogu `audio/<id>/`, gdzie `<id>` to identyfikator utworu (lowercase, bez spacji, bez polskich znaków, np. `kanon`, `barka`, `gaude_mater`).

Standardowe nazwy plików dla głosów:
- `sopran.mp3` — Sopran
- `alt.mp3` — Alt
- `tenor.mp3` — Tenor
- `bas.mp3` — Bas
- `click.mp3` — ścieżka metronomu (opcjonalna)
- `piano.mp3` — akompaniament fortepianowy (opcjonalna)

Dla układu SSAB (dwa soprany):
- `sop_h.mp3` — Sopran wysoki (S1)
- `sop_l.mp3` — Sopran niski (S2)

Dla kanonów:
- `motyw_a.mp3`, `motyw_b.mp3`, `motyw_c.mp3` — motywy

### Krok 2: Edycja `songs.json`

Dodaj nowy obiekt do tablicy `songs` w pliku `songs.json`. Wzorcowy obiekt dla **standardowego układu SATB**:

```json
{
  "id": "<id_utworu>",
  "title": "<Pełny tytuł wyświetlany użytkownikowi>",
  "meta": "SATB",
  "audioOffset": 0,
  "tracks": [
    { "id": "sopran", "name": "Sopran", "badge": "S", "badgeClass": "sop", "file": "audio/<id_utworu>/sopran.mp3", "defaultVolume": 80 },
    { "id": "alt", "name": "Alt", "badge": "A", "badgeClass": "alt", "file": "audio/<id_utworu>/alt.mp3", "defaultVolume": 80 },
    { "id": "tenor", "name": "Tenor", "badge": "T", "badgeClass": "tenor", "file": "audio/<id_utworu>/tenor.mp3", "defaultVolume": 80 },
    { "id": "bas", "name": "Bas", "badge": "B", "badgeClass": "bas", "file": "audio/<id_utworu>/bas.mp3", "defaultVolume": 80 }
  ]
}
```

### Pola obiektu `song`

| Pole | Wymagane | Opis |
|---|---|---|
| `id` | tak | Unikalny identyfikator (lowercase, bez spacji, bez polskich znaków) |
| `title` | tak | Wyświetlany tytuł utworu (może mieć polskie znaki, spacje, itd.) |
| `meta` | tak | Krótki opis, np. "SATB", "SSAB", "SATB + click track", "Kanon • 3 motywy + piano" |
| `audioOffset` | nie | Liczba taktów wstępu metronomu w mp3 (0 jeśli brak) |
| `tracks` | tak | Tablica obiektów ścieżek (patrz niżej) |

### Pola obiektu `track`

| Pole | Wymagane | Opis |
|---|---|---|
| `id` | tak | Unikalny identyfikator ścieżki w obrębie utworu |
| `name` | tak | Wyświetlana nazwa głosu, np. "Sopran", "Tenor" |
| `badge` | tak | Symbol w okrągłej ikonce (1-2 znaki, np. "S", "A", "T", "B", "S1", "🎹", "●") |
| `badgeClass` | tak | Klasa CSS koloru — patrz tabela niżej |
| `file` | tak | Ścieżka do pliku mp3 |
| `defaultVolume` | tak | Domyślna głośność 0-100 |
| `isClick` | nie | `true` dla ścieżki metronomu/piano (oddziela ją wizualnie linią) |

### Dostępne klasy kolorów `badgeClass`

| Klasa | Kolor | Standardowe zastosowanie |
|---|---|---|
| `sop` | fioletowy | Sopran (układ SATB) |
| `sop-h` | fioletowy | Sopran wysoki (układ SSAB) |
| `sop-l` | jasnofioletowy | Sopran niski (układ SSAB) |
| `alt` | pomarańczowy | Alt |
| `tenor` | zielony | Tenor |
| `bas` | niebieski | Bas |
| `click` | szary | Click track / metronom |
| `piano` | ciepły szary | Piano / akompaniament |
| `motyw-a` | różowy | Motyw A (kanony) |
| `motyw-b` | fioletowy | Motyw B (kanony) |
| `motyw-c` | turkusowy | Motyw C (kanony) |

### Kolejność ścieżek w mikserze

Standardowa kolejność dla układu SATB: **Sopran → Alt → Tenor → Bas → (click/piano na końcu z `isClick: true`)**.

Dla SSAB: **Sopran wysoki → Sopran niski → Alt → Bas**.

Dla kanonów: **Motyw A → B → C → (piano/click)**.

### Kolejność utworów na liście wyboru

Nowy utwór dodawaj **na końcu** tablicy `songs`, chyba że zostanie wyraźnie wskazane inne miejsce.

## Czego NIE robić

- **Nie modyfikuj `index.html`** przy dodawaniu utworów. Cała logika jest tam już gotowa, czyta `songs.json` automatycznie.
- **Nie zmieniaj struktury `songs.json`** — tylko dodawaj nowe obiekty do tablicy `songs`.
- **Nie wymyślaj nowych klas `badgeClass`** — używaj tylko tych z tabeli wyżej. Jeśli potrzebujesz nowego koloru, zgłoś to użytkownikowi zamiast zgadywać.
- **Nie usuwaj istniejących utworów**, chyba że pada wyraźna prośba.
- **Nie dotykaj plików mp3 w `audio/`** — są wgrywane manualnie przez użytkownika.

## Lokalne uruchomienie

```bash
python -m http.server 8000
# Otwórz http://localhost:8000
```

Pliki mp3 muszą być serwowane przez serwer HTTP (otwarcie `index.html` przez `file://` nie zadziała).
