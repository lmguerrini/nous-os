# Manuale delle viste

Le viste si scelgono nell’asse **Organizzazione**. **Natural** e **Indra** sono le opzioni ordinarie: Indra usa la disposizione ricorsiva D-071/D-072. **Indra’s Pearls · Möbius/Schottky** e **Fractal** sono sperimentali; **Holographic** resta sospesa e compare solo con il proprio opt-in sperimentale. Le viste condividono il dominio dichiarato: coordinate, stile e geometrie derivate non cambiano identità o relazioni del grafo sorgente. Le proiezioni analitiche usano il dominio divulgato, fino a 850 nodi.

## Controlli e impostazioni condivise

- **2D / 3D** cambia la proiezione geometrica. In 3D, trascina con il tasto sinistro per ruotare; la rotella ingrandisce o riduce attorno al nodo sotto il puntatore e, sullo spazio vuoto, attorno al piano del bersaglio della camera; trascina con il tasto destro o centrale, oppure con **Shift + tasto sinistro**, per traslare. Gli stessi controlli valgono per Natural, Indra e Fractal.
- **Stellare, Neurale, Micelio** cambiano la forma grafica e non l’organizzazione semantica. **Dimensione nodi**, **Spessore archi** e **Curvatura** regolano la resa; **Densità** (Essenziale, Bilanciata, Completa) regola quanti elementi sono visibili. Lo zoom semantico può rivelare livelli più profondi. Il focus evidenzia i membri pertinenti senza spostarli.
- Il pannello **Dettagli** riporta gli elementi disegnati e disponibili. Selezione e focus non trasformano gli elementi derivati in relazioni sorgente.

## Morfologie

- **Stellare** combina un campo uniforme di stelle decorative, deterministico, con polvere più tenue concentrata intorno agli hub come accento. Questi elementi non sono nodi: non hanno identificativi o relazioni, non sono selezionabili e non entrano in alcun conteggio di nodi o archi.
- **Neurale** usa somi compatti e collegamenti che raggiungono il bordo del soma. Ogni collegamento si allarga in corrispondenza di ciascun soma e torna con andamento morbido alla larghezza ordinaria verso entrambi gli estremi, lungo una curva delicata. La larghezza ordinaria è quella del cursore **Spessore archi**, in pixel a ogni livello di zoom, uguale in 2D e in 3D.
- **Micelio** disegna collegamenti continui e ondulati tra i propri estremi, con giunzioni condivise solo nei nodi reali.

I nodi predefiniti sono più piccoli; i controlli di dimensione e larghezza permettono di ingrandirli o ridurli. Le morfologie sono stili, non nuovi layout o topologie.

## Natural

Natural conserva i layout D-069…D-072. L’arrangiamento dichiarato — `constellation`, `network` o `mycelium` — governa le posizioni; la morfologia fornisce soltanto il valore iniziale. L’arrangiamento esplicito resta invariato quando si cambia morfologia.

In 2D si legge il layout planare esistente, in 3D quello volumetrico. `#projection=natural` apre la pipeline tipizzata; senza quel flag resta attivo il percorso prodotto D-072.

## Indra

**Indra** è l’organizzazione ricorsiva primaria, in 2D e 3D. Ogni nodo della gerarchia è una perla che contiene le perle figlie, impacciate in modo deterministico. Il raggio parte da 5 a 10 unità secondo la dimensione del nodo, aggiunge 3,1 volte la radice quadrata dei discendenti nascosti fino a 80 unità e cresce se serve a contenere i figli; tra le perle figlie resta un margine di almeno 7 unità o dell’8% del loro raggio medio, con un bordo esterno del 6%. I figli più grandi si dispongono per primi, con l’identificativo come spareggio, in posizioni ripetibili. Il `+N` su una perla chiusa indica quanti discendenti restano nascosti, non quanti collegamenti ha il nodo; quando un estremo di una relazione non è mostrato, il collegamento può salire alla perla visibile più vicina e conserva le relazioni sorgente che lo giustificano. Gli archi visibili restano relazioni sorgente con estremi disponibili. `#indra=legacy` è un alias del percorso legacy ricorsivo e non seleziona Indra’s Pearls.

## Indra’s Pearls · Möbius/Schottky (sperimentale)

Aggiungi `indra-pearls` alla lista `#experimental=` (per esempio `#experimental=indra-pearls,fractal`) per rendere disponibile questa opzione distinta. Selezionandola, l’URL registra `#indra=pearls`; la selezione **Indra** continua a indicare l’organizzazione ricorsiva primaria.

La variante tipizzata costruisce perle gerarchiche mediante mappe di Möbius certificate. In 2D sono dischi, in 3D semisfere di testimonianza. Se la costruzione Schottky non è certificabile, viene dichiarato il ripiego euclideo annidato, che non è un gruppo Schottky. La pagina limita la richiesta a tre livelli e 200 parole. L’apertura pigra mostra i figli e il sottografo indotto; le perle chiuse mostrano identità e conteggio senza coordinate.

## Fractal (sperimentale)

Fractal compare solo con `#experimental=fractal`. Associa il potenziale/importanza dei nodi al raggio e le comunità a settori angolari, usando guide certificate ottenute dai rami inversi della dinamica. Mostra le guide di ramificazione inversa e i percorsi aggregati conteggiati come geometrie derivate; non sono archi sorgente. In 3D l’altezza è un sollevamento scalare del potenziale, non una dinamica frattale tridimensionale.

La vista espone testimonianze numeriche della certificazione e dei percorsi. È sperimentale: i controlli di zoom e i limiti di calcolo possono lasciare livelli o geometrie non disponibili.

## Holographic (sperimentale e sospesa)

Holographic resta sospesa nell’interfaccia ordinaria. `holographic` nella lista `#experimental=` la rende disponibile come vista sperimentale. In assenza del flag, richieste salvate o URL che la selezionano ricadono su Natural con un avviso una tantum.

## Etichette, picks e provenienza

Le etichette vengono collocate vicino al proprio nodo e il posizionatore evita sovrapposizioni tra riquadri e pannelli riservati. I nomi di dominio hanno priorità e non vengono mai scartati dal budget di densità. Le etichette spostate vengono unite al proprio nodo da una linea guida sottile. Durante lo zoom con la rotella le etichette seguono la camera quando questa si ferma; alcune etichette secondarie possono non essere mostrate quando lo spazio è limitato.

Selezionare un nodo o un arco sorgente mostra la relativa informazione. Un pick su una relazione visuale, un contenitore, una curva o un campo apre la spiegazione dell’elemento derivato. Provenienza e relazioni sorgente restano distinguibili da inferenze e geometria: una curva, un contenitore o un percorso conteggiato non diventa un arco attestato.

## Rivelazione progressiva e instradamento degli archi

Quando ingrandisci, la vista aggiunge gradualmente pagine di nodi figli e i relativi collegamenti. Tutto avviene quando la camera si ferma: durante il movimento non viene ammesso o rimosso nulla. L’ordine segue prima il cluster sotto il cursore, poi quello selezionato o in focus, quindi gli altri cluster visibili, a partire da quelli più vicini al centro. Se il cursore non è sopra un nodo, la selezione e poi il centro della vista guidano la scelta. Un cambiamento del cluster seguito ha bisogno di due campionamenti concordi a camera ferma prima di avviare una nuova sequenza di rivelazione.

Ogni passo di zoom verso l’interno, una volta che la camera si è fermata, ammette una pagina limitata. Un dominio collassato apre la prima pagina al primo passo compiuto al suo interno; ogni passo successivo verso l’interno apre la pagina successiva, scendendo fino ai figli di livello 4. Da lì la vista può richiedere e rivelare i passaggi di livello 5, caricati su richiesta e mostrati per pagine invece che tutti insieme. Quando riduci lo zoom, i livelli si richiudono solo oltre soglie più basse: questo margine evita oscillazioni e sfarfallii vicino a una soglia.

Gli archi sono ricalcolati dopo la scelta dei nodi visibili: quelli con un estremo nascosto possono terminare sul suo aggregato visibile, mentre quelli che non hanno un estremo rappresentabile vengono omessi. Le relazioni nascoste dal filtro di lettura sono riportate come soppresse, insieme alla causa.

Un aggregato con un numero rappresenta il nodo visibile insieme agli elementi raccolti dietro di esso; il numero indica quanti membri rappresenta, compreso il nodo che lo mostra. Se un arco termina sull’aggregato, la spiegazione associata permette di leggere quel collegamento come percorso verso un insieme rappresentato, non come un nuovo arco sorgente.

I cambi di livello aggiornano la vista mantenendo selezione, focus e camera; una rivelazione che aggiunge nodi può ricostruire la vista conservando lo stesso viewport del mondo.

## Linea di stato

La linea di stato riporta l’organizzazione e, per le proiezioni sperimentali, i parametri, l’esito della geometria derivata o il codice e il motivo del rifiuto. Una richiesta rifiutata non viene disegnata con coordinate inventate.
