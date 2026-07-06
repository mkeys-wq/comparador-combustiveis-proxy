# CARGA+ — postos de carregamento elétrico reais

App para encontrar postos de carregamento de veículos elétricos em Portugal,
com dados reais (localização, potência, tipo de tomada) via OpenStreetMap.

## Correr localmente
```bash
npm install
npm start
```
Depois abre http://localhost:3000

## Publicar no Render
1. Sobe esta pasta para um repositório no GitHub.
2. Em render.com: New + → Web Service → liga o repositório.
3. Build Command: `npm install`  ·  Start Command: `npm start`  ·  Plano: Free.

## Limitação conhecida
Não existe fonte pública com o preço em tempo real por posto — por isso a
app mostra localização/potência/tomada reais, mas não preço.
