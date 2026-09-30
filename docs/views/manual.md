# Manuale delle viste

Le viste si scelgono nell’asse **Organizzazione**. **Natural**, **Indra’s Pearls**, **Fractal** e **Holographic** sono proiezioni alternative dello stesso dominio dichiarato: cambiano le coordinate e gli elementi derivati visibili, non il grafo sorgente. La proiezione analitica lavora sul dominio divulgato (fino a 850 nodi); l’identità e la provenienza del registro sorgente restano separate. Holographic è sperimentale: il suggerimento del pulsante dichiara «Vista sperimentale: coordinate spettrali, nessuna affermazione topologica»; lo stato e la spiegazione ripetono questa limitazione.

## Impostazioni condivise

- **2D / 3D** cambia la proiezione geometrica e la camera. Indra aggiunge in 3D semisfere sui dischi delle perle; Fractal solleva il potenziale esterno come altezza scalare; Holographic usa tre coordinate spettrali quando disponibili. Non interpretare queste geometrie come relazioni sorgente.
- **Stellare, Neurale, Micelio** sono stili grafici, non algoritmi di disposizione. Stellare usa corpi stellari e aloni; Neurale usa somi e dendriti; Micelio instrada i collegamenti in tronchi condivisi. Possono cambiare la leggibilità degli archi o dei contorni, ma non la proiezione matematica né la semantica dei dati.
- **Densità** (Essenziale, Bilanciata, Completa) regola quanti nodi, archi ed etichette sono disegnati. Lo zoom semantico sceglie il livello di dettaglio (livelli del grafo 1–5) in base all’inquadratura; avvicinarsi può rendere visibili i passaggi più profondi. Il focus evidenzia i membri pertinenti e attenua il resto senza spostarlo. I contatori nell’area dei dettagli indicano elementi disegnati e disponibili.

## Natural

Natural conserva i layout D-069…D-072. L’**arrangiamento** dichiarato — `constellation`, `network` o `mycelium` — governa le posizioni; lo stile morfologico ne sceglie solo il valore predefinito. Il readout nell’intestazione indica arrangiamento, se esplicito o derivato dallo stile, e versione del layout. Lo stesso arrangiamento produce la stessa disposizione con tutti e tre gli stili.

Con la pipeline tipizzata disattivata, il layout disegnato è quello D-072 e segue la morfologia: se non hai scelto un arrangiamento, ogni cambio di morfologia ne applica il valore predefinito. Anche un arrangiamento salvato nell’URL o nella vista che coincide con il predefinito della morfologia è considerato derivato. Un arrangiamento diverso è una scelta esplicita e viene mantenuto. Con `#projection=natural`, l’arrangiamento viene risolto una volta e resta uguale quando cambi stile.

In 2D si legge il layout planare esistente; in 3D quello volumetrico esistente. Il tasto **Natural** usa la pipeline tipizzata quando si apre la pagina con `#projection=natural`. Senza quel flag resta attivo il percorso D-072 predefinito.

## Indra’s Pearls

La vista organizza i nodi in perle gerarchiche mediante mappe di Möbius verificate. In 2D le perle sono dischi annidati/disgiunti; in 3D i dischi hanno semisfere di testimonianza. Se la costruzione Schottky non è certificabile, la pagina dichiara l’impaccamento euclideo annidato di ripiego: non è un gruppo Schottky. La richiesta della pagina è limitata a 3 livelli e 200 parole.

Seleziona una perla o porta lo zoom/focus al suo livello per **aprirla**: la pagina carica pigramente i figli e mostra il sottografo indotto reale. L’apertura usa un token legato a risultato e livello, e non rifà l’inquadratura. Per **uscire**, usa il controllo per lasciare la perla e tornare al genitore/radice; anche il ritorno conserva la camera. Le perle ancora chiuse mostrano identità e conteggio, non coordinate. Un limite di profondità o parole appare come livello non aperto con codice e motivo. `#indra=legacy` seleziona invece l’adattatore Indra legacy verificato, cioè il percorso della vista prodotto D-072.

## Fractal

Fractal associa il potenziale/importanza dei nodi al raggio e l’appartenenza comunitaria all’angolo attraverso raggi esterni inversi della dinamica certificata. La linea di stato mostra i parametri `p` e `c`; in 3D l’altezza è il potenziale esterno sollevato, non una dinamica frattale tridimensionale.

Zoom e focus possono rivelare i livelli comunitari pigramente. L’apertura segue il token del livello e lascia invariata la camera; il limite o il rifiuto di un livello compare nella linea di stato. I picks su nodo, relazione, contenitore o curva aprono una scheda di spiegazione della proiezione con testimone numerico e limiti dichiarati.

## Holographic

Holographic è sospesa e non compare nei selettori ordinari. Resta disponibile solo aggiungendo `#experimental=holographic` all’URL; una vista salvata o un URL senza flag carica Natural e mostra un avviso.

Questa vista sperimentale usa modi a bassa frequenza del laplaciano degli archi attestati per coordinate e campi derivati, senza affermare proprietà topologiche. Le coordinate sono calcolate per componente con i modi di Koren `v = D^-1/2 u`; la stessa base spettrale è usata per geometria, calore e testimoni di ricostruzione. Le componenti vengono disposte in modo deterministico. Per autospazi degeneri, la regola canonica del proiettore sceglie assi deterministici che restano autovettori effettivi; se il cluster non è isolabile, il probe è ambiguo o insufficiente, o il solver non supera i controlli numerici, le coordinate sono rifiutate e non compare un layout sostitutivo.

Il calcolo passa al worker dedicato quando il browser lo rende disponibile; il client usa invece il thread principale se non può avviare il worker, nel qual caso il calcolo lo occupa.

Quando più nodi hanno coordinate coincidenti o vicine entro la tolleranza dichiarata, un anello deterministico li separa solo sullo schermo. Gli identificativi determinano l’ordine; il testimone e la spiegazione conservano le coordinate spettrali esatte. Lo scostamento non cambia i risultati spettrali.

Se la geometria è ammessa, nel pannello **Dettagli** scegli:

- **Canale del campo**: ad esempio il segnale misurato o il calore diffuso a un tempo `t`;
- **Regione della testimonianza**: comunità o componente per cui leggere il test di ricostruzione;
- **Focus sulla regione**: limita l’inquadratura ai membri della regione; premi di nuovo **Esci dal focus sulla regione** per tornare all’insieme.

Un pick apre una scheda con spiegazione, parametri, residui e limiti. La provenienza è una sezione separata: i collegamenti aprono i record sorgente e non fanno parte della spiegazione geometrica. La scheda di ricostruzione distingue unicità di campionamento, ricostruzione esatta di un segnale band-limitato e prestazioni sul segnale misurato; non afferma che siano ricostruiti grafo, provenienza o verità.

## Picks, schede e provenienza

Selezionare un nodo o un arco sorgente mostra la relativa informazione. Un pick strutturale (relazione visuale, contenitore, curva o campo) apre la spiegazione del risultato che lo ha prodotto ed è marcato come derivato/non semantico. Le relazioni sorgente, i contributori e la provenienza mantengono una sezione distinta dalle inferenze e dalla geometria. Una spiegazione non trasforma una curva, un contenitore o una ricostruzione in un arco attestato.

## Linea di stato

- **Grafo pronto**: Natural nel percorso prodotto D-072; non è un rapporto di calcolo analitico.
- **Natural · arrangiamento · origine · versione**: arrangiamento effettivo o predefinito e versione del layout.
- **Vista Indra’s Pearls**: genere Schottky e margine di separazione, oppure impaccamento di ripiego e relativo codice; dichiara che la geometria è derivata. In 3D specifica le semisfere.
- **Vista Fractal**: `p`, `c`, raggi inversi e geometria derivata; in 3D specifica il sollevamento scalare.
- **Vista Holographic**: stato sperimentale, coordinate spettrali e assenza di affermazione topologica, poi regioni ricostruite/rifiutate, quante battono la baseline globale, errore relativo mediano e geometria derivata. In 3D specifica le tre coordinate spettrali.
- **Calcolo della proiezione in corso**: il calcolo analitico non è terminato.
- **Proiezione rifiutata [codice]**: la richiesta non ha prodotto coordinate; la linea indica il motivo e nessuna posizione rifiutata viene disegnata.
- **Livelli non aperti [codice]**: l’espansione richiesta è stata rifiutata da un limite o token; i livelli chiusi rimangono senza coordinate.

Fonti implementative: `ui/src/review/v2-page.ts` (stato, controlli e flussi), `ui/src/review/main.ts` (readout Natural e attivazione pipeline), `ui/src/review/projection-style.ts` (stili), `ui/src/review/panel-view.ts` (picks e spiegazioni).
