# Manuale delle viste

Le viste si scelgono nell’asse **Organizzazione**. **Natural** e **Indra** sono le opzioni ordinarie: Indra usa la disposizione ricorsiva D-071/D-072. **Indra’s Pearls · Möbius/Schottky** e **Fractal** sono sperimentali; **Holographic** resta sospesa e compare solo con il proprio opt-in sperimentale. Le viste condividono il dominio dichiarato: coordinate, stile e geometrie derivate non cambiano identità o relazioni del grafo sorgente. Le proiezioni analitiche usano il dominio divulgato, fino a 850 nodi.

## Controlli e impostazioni condivise

- **2D / 3D** cambia la proiezione geometrica. In 3D, trascina con il tasto sinistro per ruotare; la rotella ingrandisce o riduce puntando verso il cursore; trascina con il tasto destro o centrale, oppure con **Shift + tasto sinistro**, per traslare. Gli stessi controlli valgono per Natural, Indra e le viste sperimentali.
- **Stellare, Neurale, Micelio** cambiano la forma grafica e non l’organizzazione semantica. **Dimensione nodi**, **Spessore archi** e **Curvatura** regolano la resa; **Densità** (Essenziale, Bilanciata, Completa) regola quanti elementi sono visibili. Lo zoom semantico può rivelare livelli più profondi. Il focus evidenzia i membri pertinenti senza spostarli.
- Il pannello **Dettagli** riporta gli elementi disegnati e disponibili. Selezione e focus non trasformano gli elementi derivati in relazioni sorgente.

## Morfologie

- **Stellare** combina un campo uniforme di stelle decorative, deterministico, con polvere più tenue concentrata intorno agli hub come accento. Questi elementi non sono nodi e non hanno identificativi o relazioni.
- **Neurale** usa somi compatti e filamenti con rastremazione verso entrambi gli estremi e larghezza intermedia più sottile. Gli archi raggiungono il bordo del soma.
- **Micelio** disegna collegamenti continui e ondulati, con giunzioni condivise solo nei nodi reali.

I nodi predefiniti sono più piccoli; i controlli di dimensione e larghezza permettono di ingrandirli o ridurli. Le morfologie sono stili, non nuovi layout o topologie.

## Natural

Natural conserva i layout D-069…D-072. L’arrangiamento dichiarato — `constellation`, `network` o `mycelium` — governa le posizioni; la morfologia fornisce soltanto il valore iniziale. L’arrangiamento esplicito resta invariato quando si cambia morfologia.

In 2D si legge il layout planare esistente, in 3D quello volumetrico. `#projection=natural` apre la pipeline tipizzata; senza quel flag resta attivo il percorso prodotto D-072.

## Indra

**Indra** è l’organizzazione ricorsiva primaria D-071/D-072, in 2D e 3D. Ogni nodo gerarchico è rappresentato da una perla; i figli sono impaccati nel genitore in modo deterministico. Gli archi visibili restano relazioni sorgente con estremi disponibili. `#indra=legacy` è un alias del percorso legacy ricorsivo e non seleziona Indra’s Pearls.

## Indra’s Pearls · Möbius/Schottky (sperimentale)

Aggiungi `indra-pearls` alla lista `#experimental=` (per esempio `#experimental=indra-pearls,fractal`) per rendere disponibile questa opzione distinta. Selezionandola, l’URL registra `#indra=pearls`; la selezione **Indra** continua a indicare l’organizzazione ricorsiva primaria.

La variante tipizzata costruisce perle gerarchiche mediante mappe di Möbius certificate. In 2D sono dischi, in 3D semisfere di testimonianza. Se la costruzione Schottky non è certificabile, viene dichiarato il ripiego euclideo annidato, che non è un gruppo Schottky. La pagina limita la richiesta a tre livelli e 200 parole. L’apertura pigra mostra i figli e il sottografo indotto; le perle chiuse mostrano identità e conteggio senza coordinate.

## Fractal (sperimentale)

Fractal compare solo con `#experimental=fractal`. Associa il potenziale/importanza dei nodi al raggio e le comunità a settori angolari, usando guide certificate ottenute dai rami inversi della dinamica. Mostra le guide di ramificazione inversa e i percorsi aggregati conteggiati come geometrie derivate; non sono archi sorgente. In 3D l’altezza è un sollevamento scalare del potenziale, non una dinamica frattale tridimensionale.

La vista espone testimonianze numeriche della certificazione e dei percorsi. È sperimentale: i controlli di zoom e i limiti di calcolo possono lasciare livelli o geometrie non disponibili.

## Holographic (sperimentale e sospesa)

Holographic resta sospesa nell’interfaccia ordinaria. `holographic` nella lista `#experimental=` la rende disponibile come vista sperimentale. In assenza del flag, richieste salvate o URL che la selezionano ricadono su Natural con un avviso una tantum.

## Etichette, picks e provenienza

Le etichette vengono collocate vicino al proprio nodo e il posizionatore evita sovrapposizioni tra riquadri e pannelli riservati. I nomi di dominio hanno priorità e non vengono scartati dal budget di densità. Il posizionatore calcola una linea guida per le etichette spostate; il livello prodotto attuale non la disegna ancora. Alcune etichette secondarie possono non essere mostrate quando lo spazio è limitato.

Selezionare un nodo o un arco sorgente mostra la relativa informazione. Un pick su una relazione visuale, un contenitore, una curva o un campo apre la spiegazione dell’elemento derivato. Provenienza e relazioni sorgente restano distinguibili da inferenze e geometria: una curva, un contenitore o un percorso conteggiato non diventa un arco attestato.

## Rivelazione progressiva e instradamento degli archi

> **Segnaposto — in lavorazione.** Sezione riservata alla descrizione del controller di rivelazione, dell’instradamento degli archi e del relativo testimone. Sarà completata dopo l’integrazione di questi componenti.

## Linea di stato

La linea di stato riporta l’organizzazione e, per le proiezioni sperimentali, i parametri, l’esito della geometria derivata o il codice e il motivo del rifiuto. Una richiesta rifiutata non viene disegnata con coordinate inventate.
