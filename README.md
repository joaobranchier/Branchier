# Siren Remote Simulator

Um controlador de sirene e air horn que roda no iPhone — sem App Store, sem
Xcode, sem conta de desenvolvedor. Abre no Safari, vai para a tela de início e
funciona offline.

O ponto de partida foi o faceplate do *Siren Remote Simulator* (Android), que
não tem versão para iOS. O layout foi recriado; o áudio foi feito do zero.

![faceplate](docs/faceplate.png)

## O guia embutido

O botão lateral direito de baixo abre um guia com quatro abas: **Sirenes**,
**Botões**, **Como funciona** e **Ajustes**.

Cada sirene tem um cartão com o gráfico da sua varredura, um perfil comparativo
(alcance, urgência, penetração), para que serve na prática — e um botão para
ouvir ali mesmo, sem mexer no painel atrás.

Os gráficos são **gerados a partir das mesmas especificações que o sintetizador
lê**. Nenhum é desenhado à mão, então nenhum pode discordar do que você ouve:
mude a taxa de varredura de um tom e o desenho dele muda junto.

![guia](docs/guia.png)

## O que tem de diferente

**Nada aqui é arquivo de áudio.** Todos os tons são sintetizados ao vivo pela
Web Audio API no momento em que você aperta o botão. Isso significa:

- carrega instantâneo e ocupa alguns kilobytes
- sustenta um tom por horas sem emenda audível, porque não há loop para emendar
- o air horn responde no toque, sem latência de decodificação
- funciona offline depois de instalado

E, principalmente: os tons são **calibrados pelas especificações publicadas dos
fabricantes**, não aproximados de ouvido. As faixas de frequência e as taxas de
varredura são as de verdade.

| Tom | Especificação de origem |
|---|---|
| **WAIL-1** | Federal Signal PA300 · 725–1800 Hz · 15 cpm |
| **WAIL-2** | PA300-012MSC · 700–1600 Hz · 11 cpm · varredura assimétrica |
| **YELP** | Federal Signal PA300 · 725–1800 Hz · 220 cpm |
| **PHSR** | PA300 Priority · 725–1800 Hz · 1300 cpm + batimento |
| **HI-LO** | DIN 14610 / Martin-Horn · 440 ↔ 585 Hz (lá/ré) · 70 cpm |
| **WA.WA** | 725–1800 Hz · 132 cpm com AM sincronizada |
| **AIR HORN** | Nathan AirChime · acorde a partir de 311 Hz (ré♯) |
| **Q-SIREN** | Federal Signal Q2B · rotor de 14 portas · 400–800 Hz |
| **RUMBLE** | Classe Rumbler · 182–400 Hz, acompanhando a sirene ativa |
| **MANUAL** | Wail manual · 600–1750 Hz, controlado pelo dedo |

`cpm` = ciclos por minuto, a unidade que os fabricantes usam.

## Instalar no iPhone

1. Abra o endereço no **Safari** (precisa ser o Safari — o Chrome no iOS não
   instala PWA).
2. Toque em **Compartilhar** (o quadrado com a seta para cima).
3. Role e escolha **Adicionar à Tela de Início**.
4. Toque em **Adicionar**.

Pronto. O ícone aparece junto com os outros apps, abre em tela cheia sem a barra
do Safari, e a partir daí não precisa mais de internet.

> **Instale antes de usar para valer.** Fora do modo tela cheia o iOS é bem mais
> agressivo em bloquear a tela e suspender o áudio.

## Os botões

| Botão | O que faz |
|---|---|
| **WAIL-1 / WAIL-2 / YELP / HI-LO / PHSR / WA.WA** | Travam um tom. Toque de novo para desligar. |
| **AIR HORN** | Momentâneo — só soa enquanto o dedo está em cima. |
| **MANUAL** | Momentâneo. Segure para subir o tom; solte e ele desce sozinho. |
| **Q-SIREN** | A eletromecânica: sobe devagar e desce em roda-livre por ~19 s. |
| **RUMBLE** | Acrescenta a camada grave por baixo do que estiver tocando. |
| **HIGH / BASS** | Equalização. HIGH corta e alcança longe; BASS dá corpo. Podem ser combinados. |
| **MOD** | Altera a velocidade de varredura do tom ativo: SLOW / STD / FAST. |
| **MIX** | Empilha tons em vez de trocá-los. |
| **AUTO** | Varre wail → yelp → phaser sozinho. |
| **LMB** | Giroflex vermelho/azul piscando **atrás** do controle — os botões continuam funcionando. Vem desligado e só acende aqui: nenhuma sirene liga a luz sozinha. |
| **LIGHT** | Luz branca em tela cheia (serve de lanterna). Toque para sair. |
| **STOP** | Corta tudo na hora. |
| Laterais | Volume (esquerda), liga/desliga e ajustes (direita). |

Tudo também funciona por teclado: Tab para navegar, Enter ou Espaço para
acionar. Nos botões momentâneos o som dura enquanto a tecla fica pressionada.

## Como o som é feito

As sirenes de varredura usam um oscilador de baixa frequência modulando a
frequência de **dois** osciladores portadores afinados com alguns hertz de
diferença. Essa diferença reproduz o batimento de um par de alto-falantes
reais — é um detalhe pequeno que responde por boa parte do realismo.

```
LFO ─► profundidade (Hz) ─┬─► portadoraA.frequency   (base = centro)
                          └─► portadoraB.frequency   (base = centro + desvio)
```

Depois tudo passa por uma simulação do próprio alto-falante de sirene: corte
grave, realce em torno de 1,6 kHz e corte agudo — a resposta de um driver de
compressão com corneta. Sem esse estágio o resultado soa como um sintetizador
tocando uma varredura; com ele, soa como uma sirene.

A varredura assimétrica do WAIL-2 usa uma tabela harmônica derivada por DFT da
forma de onda exata. A fórmula fechada que costuma ser citada para esse
formato só tem termos seno, e um triângulo assimétrico não é função ímpar — ela
coloca o pico no lugar errado. Integrar numericamente resolve, e o custo
aparece uma vez na inicialização.

O air horn são três trombetas afinadas em acorde, levemente desafinadas entre
si, com jato de ar no ataque e queda de pressão ao soltar. A Q-siren segue a
física do rotor: `f = (rpm ÷ 60) × portas`, com 14 portas, subida sob carga e
descida longa por causa da embreagem de roda-livre.

## Rodando localmente

```bash
npm install     # só para os testes
npm start       # serve em http://localhost:8099
```

Precisa ser servido por HTTP — módulos ES não carregam via `file://`.

## Testes

São duas suítes.

**`npm test`** — o projeto inteiro é uma afirmação sobre frequências, e
afirmação sobre frequência se mede. Renderiza cada voz em um
`OfflineAudioContext` e confere o resultado contra os números da tabela acima:
a taxa de varredura pelo rastro do centroide espectral, a altura por *harmonic
product spectrum* (o 2º harmônico de uma sirene fica só ~2 dB abaixo da
fundamental, então um detector de "bin mais alto" troca de oitava no meio da
varredura). Também verifica que a saída nunca passa de fundo de escala,
inclusive empilhando sirene + rumble + air horn no volume máximo.

**`npm run test:ui`** — dirige o faceplate de verdade num navegador de verdade
(precisa do `npm start` rodando). Cada verificação aqui corresponde a um defeito
que ler o código não pegou:

- o STOP deixava a Q-siren descendo por 19 segundos, porque chamava o release
  normal em vez de matar a voz;
- o RUMBLE lia `.lo`/`.hi` direto do tom ativo, e as especificações mecânica e
  de buzina não têm esse par — chegava ao oscilador como NaN e lançava exceção;
- a air horn ficava presa para sempre se o primeiro toque terminasse antes de o
  `AudioContext` acabar de ser construído;
- o wake lock era liberado e repedido a cada troca de tom, reiniciando o
  temporizador de inatividade do iOS a cada toque;
- um tom com cauda longa desligado pela própria tecla saía dos registros na
  hora, mas continuava soando — então o STOP depois disso não o alcançava, e
  o medidor de nível marcava zero enquanto a Q-siren ainda descia a todo
  volume;
- o modelo de frequência da Q-siren aproximava por uma exponencial só o que
  o áudio faz em dois segmentos, divergindo por mais de 4× no meio da subida:
  o mostrador mentia e desligar a sirene antes do regime derrubava o tom de
  uma vez.

```
58/58 checks passed     (áudio)
47/47 UI checks passed  (navegador)
```

Os ícones são gerados por `python3 tools/make-icons.py`, que escreve os PNGs à
mão — sem dependência de biblioteca de imagem.

## Publicando

Um push dispara o workflow, que roda as duas suítes e só então publica no
GitHub Pages.

**Antes do primeiro deploy funcionar, o Pages precisa ser ligado uma vez:**

> Settings → Pages → Build and deployment → Source → **GitHub Actions**

Sem isso o job de deploy falha com *"Get Pages site failed"*.

Não dá para automatizar esse passo. A `configure-pages` sabe criar o site com
`enablement: true`, mas essa chamada precisa do escopo `administration` — e
`administration` não está entre os escopos que um workflow pode pedir para o
`GITHUB_TOKEN`. Pedi-lo torna o próprio arquivo de workflow inválido e a
execução falha antes de qualquer job começar. Funcionaria só com um token
pessoal de administrador guardado no repositório, o que é bem pior do que uma
visita a uma tela de ajustes.

Depois de ligado, o endereço é
`https://<usuário>.github.io/<repositório>/`.

## Avisos

**Volume e audição.** Ligado a uma caixa de som, esse material chega fácil a
níveis que machucam. Comece baixo.

**Fotossensibilidade.** Os botões LMB e LIGHT piscam forte. Quem tem epilepsia
fotossensível deve deixá-los desligados.

**Uso.** Simulador para uso pessoal, estudo e produção de áudio. Imitar sirene
de viatura em via pública é infração — e, dependendo da situação, crime — na
maior parte do mundo, Brasil incluído. Não use para se passar por autoridade
nem para obrigar alguém a sair da frente.

## Fontes dos números

- Federal Signal PA300, modelos 690000/690001 — faixa 725–1800 Hz; wail 15 cpm,
  yelp 220 cpm, hi-lo 70 cpm, priority 1300 cpm. Modelo 012MSC: 700–1600 Hz.
- DIN 14610 (Martinshorn) — dois tons fixos a uma quarta justa, razão 1:1,33,
  dentro de 360–630 Hz; Martin-Horn afinado em lá/ré (440/585 Hz).
- Sirene classe Rumbler — 182–400 Hz, tocada em conjunto com a sirene aguda.
- Buzinas de acorde Nathan AirChime — fundamentais entre ~311 Hz (ré♯) e
  415 Hz (sol♯); harmônicos acima de 5 kHz.
- Federal Signal Q2B — rotor de 14 portas, 123 dB a 3 m, fundamental variável
  com a rotação (≈400–800 Hz em regime), embreagem de roda-livre.
