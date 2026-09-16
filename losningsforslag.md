# Folksam Challenge: AI Investment Analysis
### Handes lösningsförslag (MVP-utkast)

---

## bakgrund

Uppdraget är att bygga ett verktyg som gör det snabbare och tydligare för en investeringskommitté att resonera sig fram till ett beslut om AI-case, inte ett verktyg som fattar beslutet åt dem. Grundkraven är tydliga: bedöm caset per värdekategori, visa resonemanget bakom varje bedömning, räkna fram en sammanvägd prioriteringspoäng.

En bokstavlig tolkning av uppgiften, fyra kategorier, en siffra per kategori, ett vägt snitt, löser kraven på papper. Problemet är att alla lag som läser samma brief troligen landar i ungefär samma lösning. En sådan version bevisar att man förstått uppgiften. Den bevisar inte att caset faktiskt går att lita på, eller inspirerar en jury.

Det här förslaget bygger vidare på grundkraven men lägger till mekanismer som gör "ska inte tas emot okritiskt" till något användaren faktiskt tvingas göra, inte bara en brödtext ingen läser.

## vad verktyget konkret gör

**1. tar emot input**
En beskrivning av ett AI-investeringscase: vad det ska göra, vilka resurser/kostnader det kräver, vilken data eller kompetens som behövs.

**2. bedömer caset per värdekategori**
Effektökning, kompetenshöjning, nytto-/innovationshöjning, riskreducering. Varje kategori får en poäng, en kort motivering knuten till vad caset faktiskt säger (inte generiska AI-fördelar), och en konfidensnivå som visar hur säker bedömningen är givet informationen i caset.

**3. visar resonemanget, inte bara siffran**
Varje kategori får en kort delbedömning som visar vad som vägdes in. När resonemanget bygger på en jämförbar verklig AI-satsning visas källan (titel och länk) bredvid, hämtad via sökning i realtid, inte påhittad. Saknas verklig grund för en jämförelse sägs det rakt ut istället för att gissa.

**4. flaggar vad som saknas**
Innan caset poängsätts pekar verktyget ut konkreta luckor i beskrivningen, till exempel vem som äger datan eller vad driftskostnaden är, som skulle förändra bedömningen om de fylldes i.

**5. räknar fram en sammanvägd poäng**
Ett snitt av de fyra kategorierna, presenterat som utgångspunkt för diskussion, inte facit.

## vad som gör det här annorlunda

**motargument istället för rapport.** Verktyget tar rollen som en skeptisk kommittémedlem och ifrågasätter svaga påståenden i caset istället för att bara redovisa en bedömning. Användaren får försvara sina påståenden, och bedömningen växer fram ur den dialogen. Det är skillnaden mellan att säga "det här ska inte tas emot okritiskt" och att faktiskt göra okritiskt mottagande omöjligt.

**olika vägar beroende på risktolerans.** Samma case kan läsas olika beroende på hur mycket risk organisationen är villig att ta. Verktyget kan visa hur prioriteringen ändras under olika hållningar, till exempel riskavert, tillväxtfokuserad, kostnadsfokuserad, istället för att låtsas att det bara finns ett rätt svar.

**minne av kommittén.** När en människa justerar eller ifrågasätter en bedömning kan det sparas, så att verktyget över tid kalibreras mot hur just den här gruppen faktiskt resonerar, snarare än ett generiskt AI-omdöme.

**tekniska skyddsmekanismer.** Låg temperatur på modellanropet så att samma case inte poängsätts olika mellan körningar, samt en logg över input, poäng och resonemang för spårbarhet.

## vad verktyget inte är

Inte en automatiserad beslutsmotor som ersätter mänskligt omdöme.

Inte ett objektivt sanningsverktyg. Bedömningen är en tolkning baserad på tillgänglig information, inte ett faktum, oavsett hur självsäkert den presenteras.

Inte något som ska gå att övertyga med enbart retorik. En invändning från användaren ska bara flytta en poäng om den tillför konkret ny information, inte bara upprepad övertygelse. Annars återskapar motargument-funktionen exakt det problem den är tänkt att lösa.

## kvarstående luckor

Kostnad väger inte in i den sammanvägda poängen ännu. Briefen ber om en värde-/ROI-poäng som väger kategorierna mot kostnaden, men nuvarande poäng är bara ett snitt av de fyra värdekategorierna. Caset behöver ge en kostnadsuppskattning som faktiskt påverkar slutpoängen.

Minne av kommittén går inte att visa live utan simulerad historik, eftersom det inte finns riktiga tidigare beslut att luta sig mot ännu.

Ingen inbyggd kontroll ännu för om bedömningen påverkas mer av hur caset är skrivet än vad det faktiskt säger. Värt att testa manuellt innan det byggs som funktion.

Lösningen förutsätter en användare i taget. Ett riktigt kommittémöte har flera personer med olika uppfattning samtidigt, vilket inte är löst än.

## stretch goals

En enkel vy där flera case kan jämföras sida vid sida (briefens eget stretch goal).
