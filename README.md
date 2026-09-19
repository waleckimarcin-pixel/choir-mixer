# Choir Voice Mixer

Mikser partii chóralnych dostępny pod adresem https://sznyclo.netlify.app/.
Statyczna aplikacja działa bez kont i procesu kompilacji.

## Obsługa i struktura

- Wybór utworu, wspólne odtwarzanie, pauza, przewijanie i niezależne głośności głosów.
- Zapamiętywanie głośności osobno dla każdego utworu w tej samej przeglądarce.
- Wybór ćwiczonej partii, który eksponuje dany głos w miksie.
- Bezpośredni link do utworu, np. `https://sznyclo.netlify.app/?song=sweet_dreams`.
- Powtarzanie fragmentu między punktami A i B.
- Informacja o problemie z wczytaniem nagrania i możliwość ponowienia.

```text
index.html            wygląd i kontrolki
app.js                interfejs, lista utworów i zapis ustawień
audio-engine.js       wspólna obsługa odtwarzania ścieżek
songs.json            repertuar i ustawienia głosów
audio/<id_utworu>/    pliki MP3
scripts/validate.mjs   kontrola konfiguracji i nagrań
scripts/serve.mjs      lokalny serwer z obsługą przewijania MP3
tests/                testy automatyczne
```

Przy zwykłym dodawaniu utworu zmieniaj wyłącznie `songs.json` oraz dodawaj jego pliki w `audio/`.
Zmiany aplikacji są osobnym zadaniem.
Zachowuj istniejący repertuar i jego pliki.

## Dodanie utworu

1. Zachowaj oryginalne nagrania WAV poza katalogiem publikowanej strony.
2. Umieść MP3 wszystkich partii w `audio/<id_utworu>/`. Identyfikator powinien używać małych liter ASCII, cyfr oraz `_` lub `-`, np. `sweet_dreams`.
3. Dopisz utwór na końcu tablicy `songs` w `songs.json`, chyba że użytkownik wskazał inne miejsce.
4. Uruchom walidację i testy, sprawdź odsłuchem synchronizację oraz opublikuj cały katalog aplikacji na istniejącej stronie Netlify.

Wzór SATB:

```json
{
  "id": "sweet_dreams",
  "title": "Sweet Dreams",
  "meta": "SATB",
  "tracks": [
    { "id": "sopran", "name": "Sopran", "badge": "S", "badgeClass": "sop", "file": "audio/sweet_dreams/sopran.mp3", "defaultVolume": 80 },
    { "id": "alt", "name": "Alt", "badge": "A", "badgeClass": "alt", "file": "audio/sweet_dreams/alt.mp3", "defaultVolume": 80 },
    { "id": "tenor", "name": "Tenor", "badge": "T", "badgeClass": "tenor", "file": "audio/sweet_dreams/tenor.mp3", "defaultVolume": 80 },
    { "id": "bas", "name": "Bas", "badge": "B", "badgeClass": "bas", "file": "audio/sweet_dreams/bas.mp3", "defaultVolume": 80 }
  ]
}
```

Każdy utwór wymaga unikalnego `id`, tytułu `title`, opisu `meta` i niepustej tablicy `tracks`.
Każdy głos wymaga unikalnego w obrębie utworu `id`, nazwy `name`, symbolu `badge`, klasy koloru `badgeClass`, ścieżki `file` i liczbowej głośności `defaultVolume` od 0 do 100.
Opcjonalne `isClick: true` oznacza metronom lub akompaniament oddzielony wizualnie od partii wokalnych.
Opcjonalne `audioOffset` pozostaje polem informacyjnym dla starszych wpisów — odtwarzacz go ignoruje i nie przesuwa nagrań.

Dozwolone klasy `badgeClass`: `sop`, `sop-h`, `sop-l`, `alt`, `tenor`, `bas`, `click`, `piano`, `motyw-a`, `motyw-b`, `motyw-c`.
Kolejność standardowa: sopran → alt → tenor → bas → metronom lub piano; dla SSAB: sopran wysoki → sopran niski → alt → bas.
Ścieżki zapisuj w całości, np. `audio/sweet_dreams/alt.mp3`; wielkość liter musi odpowiadać plikom.

## Konwersja nagrań

Wszystkie głosy eksportuj z tego samego punktu czasu, z tymi samymi ustawieniami.
Przykład dla jednego pliku (powtórz dla każdej partii):

```bash
ffmpeg -i "sopran.wav" -map 0:a:0 -c:a libmp3lame -b:a 192k -ar 44100 -ac 2 "audio/sweet_dreams/sopran.mp3"
```

Nie przycinaj ciszy, nie zmieniaj tempa i nie normalizuj każdej partii niezależnie.
Zachowaj wspólny początek i balans nagrań źródłowych; nie nadpisuj WAV ani wcześniejszych MP3.
Jednakowa długość plików nie gwarantuje zgodnego początku muzyki — potrzebny jest również odsłuch miksu.

## Uruchomienie i kontrola

Z katalogu aplikacji:

```bash
node scripts/serve.mjs
# Otwórz http://127.0.0.1:8000
# W drugim terminalu:
node scripts/validate.mjs
node --test tests/*.test.mjs
```

Stronę otwieraj przez HTTP, nie przez `file://`.
Podany serwer obsługuje żądania HTTP Range (odpowiedzi 206), potrzebne do przewijania strumieniowanych MP3. Prosty serwer bez tej obsługi może odtwarzać nagrania, ale cofać przewijanie do początku.
Walidator wymaga Node.js i `ffprobe` z pakietu FFmpeg w `PATH` (alternatywnie ustaw `FFPROBE_PATH` na plik wykonywalny).
Sprawdza konfigurację, identyfikatory, kolory, głośności, bezpieczne ścieżki, istnienie i wielkość liter nazw plików oraz pełny odczyt ramek audio.
Podaje długość odczytanego dźwięku, częstotliwość, liczbę kanałów i próbek dla każdej partii.
Błędy kończą proces kodem 1. Różnice długości są ostrzeżeniami wymagającymi sprawdzenia źródeł; nie blokują starszego repertuaru ani nie modyfikują plików.

Przed publikacją sprawdź także odtwarzanie na telefonie, zmianę utworu, koniec najdłuższej ścieżki, zapamiętany miks, link do utworu i pętlę A–B.
Publikuj `index.html`, `app.js`, `audio-engine.js`, `songs.json` i kompletny `audio/` na tej samej stronie Netlify; nie zastępuj repertuaru samym nowym utworem.
