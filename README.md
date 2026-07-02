# Comparador Combustível+ — servidor proxy

Este servidor liga a app aos preços reais da DGEG/ERSE, porque o browser não pode
chamar `precoscombustiveis.dgeg.gov.pt` diretamente (bloqueio de CORS).

## ⚠️ Antes de publicar: primeira verificação (obrigatória)

Os nomes dos campos e os IDs de tipo de combustível usados neste código
(`FUEL_IDS` e `normalizeStation()` em `server.js`) são a **melhor estimativa**
feita a partir de investigação pública — não foram confirmados com uma chamada
real bem-sucedida à API, porque o ambiente onde este código foi escrito não
tem acesso de rede ao site da DGEG. É preciso confirmar isto uma vez, num
sítio com internet normal (o teu computador, ou Claude Code):

```bash
npm install
npm start
```

Depois, no browser (ou com curl), abre:

```
http://localhost:3000/api/debug/raw-search?id=3201
```

Isto mostra a resposta **crua** da DGEG para esse ID de combustível. Confirma:

1. **O ID 3201 corresponde mesmo a "Gasolina simples 95"?** — Se a resposta tiver
   um campo com o nome do combustível, confere. Se não, tenta outros valores
   próximos (3200, 3202, 3203…) até encontrares os 7 tipos e atualiza
   `FUEL_IDS` em `server.js`.
2. **Os nomes dos campos** — confirma como se chamam de facto os campos de
   latitude, longitude, preço, nome do posto, marca, morada, etc., e ajusta a
   lista de nomes candidatos em `normalizeStation()` se for preciso (a função
   já tenta várias variantes comuns, mas pode não cobrir a real).

Também podes inspecionar um posto individual:

```
http://localhost:3000/api/debug/raw-posto?id=67080
```

Depois de confirmado, testa o endpoint principal:

```
http://localhost:3000/api/postos?fuel=gasoleo&lat=40.9333&lon=-8.25&raio=15
```

Deve devolver uma lista de postos reais, ordenada por preço, dentro do raio.

Abre `http://localhost:3000` no browser — a app já tenta automaticamente usar
estes dados reais (mostra "● dados em direto" junto ao mapa); se a chamada
falhar por qualquer razão, volta sozinha para os dados de exemplo
("● dados de exemplo"), para nunca ficares com a app "partida".

## Publicar online (Render — grátis para começar)

1. Cria uma conta em https://render.com (podes usar o GitHub para entrar).
2. Sobe esta pasta para um repositório no GitHub (novo repo, `git init`,
   `git add .`, `git commit -m "primeira versão"`, `git push`).
3. No Render: **New +** → **Web Service** → liga o repositório.
4. Configuração:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plano:** Free (nota: adormece após 15 min sem uso; demora ~30s a
     "acordar" no pedido seguinte — normal no plano gratuito)
5. Depois de publicado, terás um URL do tipo
   `https://comparador-combustiveis.onrender.com` — a app funciona a partir
   daí, incluindo no telemóvel.

## Estrutura

- `server.js` — servidor Express (proxy + cache + cálculo de distâncias)
- `public/index.html` — a app (frontend), servida automaticamente pelo servidor
- Cache em memória: os preços de cada combustível ficam guardados 1 hora antes
  de serem pedidos de novo à DGEG (os preços só mudam uma vez por dia)

## Limitações atuais (por desenho, não por engano)

- **GPL, gasóleo agrícola, etc.** seguem o mesmo mecanismo — assim que os IDs
  estiverem confirmados, funcionam da mesma forma.
- **Carregamento elétrico** continua com dados de exemplo — a DGEG não trata
  desse tema. Precisaria de uma segunda integração (ex: MOBI.E).
- Sem base de dados persistente — a cache é só em memória e reinicia quando o
  servidor reinicia (aceitável para este volume de dados; pode evoluir para
  Redis/SQLite mais tarde se fizer sentido).
