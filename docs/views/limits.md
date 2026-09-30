# Limiti e rifiuti delle viste

Le viste proiettano un dominio analitico esplicito fino a 850 nodi. Il registro semantico completo rimane distinto. Un rifiuto numerico produce uno stato tipizzato senza coordinate; non viene sostituito da un layout casuale o da una geometria di ripiego non dichiarata. Le soglie sotto sono limiti implementati o risultati misurati, non promesse di prestazione universali.

## Natural

Natural riusa i layout esistenti: non offre un nuovo solver di stress. La pipeline tipizzata è attivata con `#projection=natural`; senza flag il percorso D-072 resta quello predefinito. L’arrangiamento è Natural-only e deve essere `constellation`, `network` o `mycelium`; uno sconosciuto è rifiutato alla normalizzazione e una disposizione Flat legacy è letta solo come alias migrato. La vista non ha codici di rifiuto numerico propri documentati: gli errori di input seguono il contratto `ViewInput`.

La gate Natural registra coordinate allineate al layout legacy in 11/11 fixture. La pipeline tipizzata è stata oracle-pinned e i test di permutazione sono entro `1e-9`. La profilazione pipeline-on era rinviata durante la gate Natural; questi dati non equivalgono a un benchmark complessivo corrente.

## Indra’s Pearls

- Il dominio è limitato a 850 nodi; il gruppo Schottky usa al massimo 4 coppie generatrici. Il margine di separazione della pagina è `0.02`; tolleranza ammessa al più `0.05`. Condizionamento di generatore/parola oltre `1e9`, dischi sovrapposti o tangenti, mappe esterne non valide e round-trip fuori soglia rifiutano la costruzione.
- La pagina richiede al massimo 3 livelli e 200 parole (`v2-page.ts`); il contratto consente una profondità intera in `1..16`, rifiutando richieste oltre il massimo dichiarato con `depth-cap-exceeded`. Ogni espansione pigra deve stare nel budget di parole configurato: altrimenti `word-cap-exceeded`; il carico può anche rifiutare `node-budget-exceeded`, `invalid-parent-word`, `token-level-mismatch` o `assignment-refusal`. Un token obsoleto non apre un livello del risultato attuale. Un livello oltre `maxDepth` è rifiutato, non presentato come frontiera-leaf.
- Genere inferiore a 2 non ammette un gruppo Schottky; quando non ci sono abbastanza figli per due coppie, è possibile soltanto il ripiego euclideo annidato dichiarato. Non attribuirgli proprietà Schottky.
- Sul caso verificato, κ massimo ai prefissi di profondità 4 era circa `1.76e8`, sotto il limite `1e9`, ma con margine ridotto; profondità massima usata dalla pagina (3) risultava nel regime verificato. Un’altra nota: il cache LRU per-livello è testato ma non collegato all’assembly; le espansioni pure possono essere ricalcolate.

Fonti: `ui/src/review/v2-page.ts` (`INDRA_PAGE_MAX_DEPTH=3`, `INDRA_PAGE_MAX_WORDS=200`, margine `0.02`), `ui/src/projection/indra.ts` (`INDRA_DOMAIN_NODE_CAP`, `INDRA_MAX_GENERATOR_PAIRS`, tolleranze, profondità e rifiuti), `ui/src/indra/levels.ts` (cap e codici di livello), `ui/src/indra/schottky.ts` (separazione e certificazione).

## Fractal

- Il dominio massimo è 850; `p` deve essere 2 o 3, i parametri devono corrispondere alla dinamica certificata, la partizione comunitaria deve essere valida e ogni nodo deve ricevere una coordinata. Non si accettano caricamenti parziali di livello.
- Per G5(b), il rapporto di località degli archi per ogni comunità ammissibile e sottosettore richiesto non deve superare **0.5**, rispetto alle baseline deterministiche. Un valore superiore causa `edge-locality-refusal`; solver Fiedler rifiutato dà `fiedler-solver-refused`. Per il gigante oltre il 50% vale la regola G5.1: soltanto figli-gruppo reali con almeno due membri diventano sottosettori contigui, proporzionali alla dimensione; i figli foglia restano nell’intervallo residuo e seguono l’ordinamento di località deterministico.
- Il residuo dei raggi inversi e il confronto di livello devono rispettare la tolleranza dei parametri (gate di qualifica `1e-6`); un salto di ramo non valido, dinamica non certificata o residuo eccessivo produce `uncertified-dynamics`, `inverse-ray-failed` o rifiuto di parametri. La dispersione radiale IQR/mediana deve essere almeno **0.15** (`radial-spread-refusal`). Nessun nodo può essere perso: la ritenzione mappata richiesta è 100%.
- La qualifica sintetica a 850 nodi ha misurato residuo inverso massimo `9.972e-12`, residuo regioni `9.908e-12`, residuo equipotenziali `1.258e-12`, IQR radiale/mediana `0.766643`; 11 insiemi ammissibili hanno superato la località. Sono qualifiche di quei dati e commit, non garanzia per ogni grafo; una comunità a clique può essere rifiutata perché nessun ordine soddisfa il limite.
- La vista 3D è un sollevamento scalare del potenziale esterno, non un frattale spaziale. Il routing Mycelium e i dendriti Neurali possono rendere più difficile leggere settori e raggi.

Fonti: `ui/src/fractal/assignment.ts` (`EDGE_LOCALITY_RATIO_LIMIT`, G5.1 e Fiedler), `ui/src/projection/fractal.ts` (cap, convalida e codici di rifiuto).

## Holographic (sperimentale)

- La matrice spettrale usa archi attestati e un massimo dichiarato di 850 nodi. La decomposizione densa di riferimento è limitata a 172; oltre il default passa a Lanczos. Lanczos è limitato a 8 riavvii, 512 colonne proiettate e tolleranza residua predefinita `1e-8`; nonconvergenza, ortogonalità insufficiente o taglio non ammesso diventano rifiuti espliciti, non layout sostitutivi.
- La politica degli assi per autospazi degeneri è **in revisione** verso assi di prova canonici basati sul proiettore. La specifica e il codice descrivono `projector-probe-v1`: i cluster spettrali non si dividono; soglie, rango o stabilità dei probe non superati rifiutano con `ambiguous-eigenspace`, `insufficient-rank` o `solver-failure`. Un rifiuto lascia ID caricati e mappe di posizione vuoti.
- Il recupero sceglie il massimo prefisso di modi con rango pieno e condizionamento campione al più **30**. Un campione senza rango sufficiente dà `rank-deficient`. La baseline headline è `global-mean-v1`; è inoltre calcolata la baseline di vicinato. Rango/condizionamento e baseline sono predefiniti prima di esaminare i valori esclusi. Unicità per la banda scelta non implica ricostruzione degli assi geometrici o dell’intero embedding.
- Rapporti misurati su grafi sintetici da 850 nodi: su 17 comunità, unicità `17/17`, embedding completo esatto `1/17`, calore comunitario band-limitato esatto `17/17`, importanza migliore della baseline globale `0/17`; su 40 comunità, rispettivamente `40/40`, `0/40`, `40/40`, `0/40`. Errore relativo mediano dell’embedding nel complemento: `1.224` (17 comunità) e `1.309` (40); heat band-limitato circa `3.54e-16` e `4.21e-16`. La sintesi precedente di 850 nodi riportava inoltre recupero dell’importanza `0/17` e errore mediano `1.19e7`; il cambiamento delle misure è visibile nei report delle versioni successive. Nessuno di questi valori dimostra recupero generale del grafo o delle fonti; la vista resta sperimentale e deve mostrare gli esiti della baseline.
- In 3D, tre coordinate spettrali sono disponibili solo quando gli autospazi richiesti sono sufficientemente stabili; il loro valore non è profondità fisica.

Fonti: `ui/src/holographic/geometry.ts` (cluster e codici geometrici; politica assi), `ui/src/holographic/lanczos.ts` (limiti solver), `ui/src/holographic/recovery.ts` (rango, condizione 30 e baseline), `ui/src/projection/holographic.ts` (dominio e diagnostica).
