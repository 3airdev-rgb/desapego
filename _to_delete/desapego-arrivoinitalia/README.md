# DESAPEGO

Vitrine de itens usados para vizinhos do condomínio. Cada item tem fotos em carrossel, preço à vista, parcelamento em até 6x (custo repassado ao comprador) e reserva de 48 horas com fila de interessados.

## Requisitos

- Node.js 22.13 ou superior (usa `node:sqlite`, sem dependências nativas).

## Execução local

```bash
npm install
cp .env.example .env   # edite ADMIN_PASSWORD e demais variáveis
export $(grep -v '^#' .env | xargs)
npm start
```

- Vitrine: http://localhost:3000
- Painel: http://localhost:3000/admin

## Execução local com Docker Desktop (recomendado antes de publicar)

1. Crie o arquivo de configuração:

```bash
cp .env.example .env
```

Edite o `.env` e defina pelo menos `ADMIN_PASSWORD`. Para testar o Pix, informe `PIX_CHAVE`. Para o cartão, `MP_ACCESS_TOKEN` (credencial de teste) e `MP_CUSTO_PARCELADO_PCT`.

2. Crie a pasta de dados (evita problemas de permissão no Linux):

```bash
mkdir -p data
```

3. Suba a aplicação:

```bash
docker compose up --build
```

- Vitrine: http://localhost:3111
- Painel: http://localhost:3111/admin

O banco SQLite e as fotos ficam na pasta `data/` do seu computador, então sobrevivem a reinícios do container. Para parar: `Ctrl+C` ou `docker compose down`. Para apagar tudo o que foi testado, pare o container e remova a pasta `data/`.

Os valores de `PUBLIC_BASE_URL` e `DATA_DIR` são sobrescritos pelo `docker-compose.yml` para o ambiente local.

## Testes

```bash
npm test
```

Cobrem cálculo de parcelamento, payload Pix com CRC, regras de reserva e fila, e o fluxo HTTP completo com Mercado Pago simulado.

## Configuração

| Variável | Função |
|---|---|
| `ADMIN_PASSWORD` | Senha do painel (obrigatória) |
| `PUBLIC_BASE_URL` | Endereço público; use `https://` em produção |
| `DATA_DIR` | Banco SQLite e fotos (fora do código em produção) |
| `RESERVA_HORAS` | Duração da reserva (padrão 48) |
| `WHATSAPP_NUMERO` | Número do vendedor com DDI e DDD |
| `PIX_CHAVE` | Chave Pix estática (conta Inter); sem ela, o Pix fica desativado |
| `MP_ACCESS_TOKEN` | Credencial do Mercado Pago |
| `MP_CUSTO_PARCELADO_PCT` | Percentual total retido pelo Mercado Pago na venda em 6x, incluindo antecipação. Sem ele, o cartão parcelado fica desativado |

## Regras de negócio

- **Publicação:** só itens marcados como "Disponibilizar para venda" aparecem na vitrine.
- **Reserva:** o primeiro interessado recebe reserva de `RESERVA_HORAS`. Os seguintes entram na fila.
- **Expiração:** a cada minuto, reservas vencidas são encerradas e o próximo da fila é promovido e sinalizado no painel para aviso manual pelo WhatsApp.
- **Pix à vista:** código copia e cola com valor fixo. A confirmação é manual, pelo painel ("Registrar venda").
- **Cartão em 6x:** o total é calculado para que o vendedor receba o valor à vista após a retenção do Mercado Pago. A confirmação chega por webhook em `/webhooks/mercadopago`.

## Estrutura

```
src/        servidor, regras de negócio, banco e integração Mercado Pago
public/     vitrine, página do item e painel administrativo (HTML/JS puro)
tests/      testes automatizados
```

## Publicação na VPS

1. Instalar Node.js 22 na VPS e clonar ou enviar o projeto (sem `node_modules`, `data/` e `.env`).
2. Rodar `npm ci --omit=dev` e criar o `.env` de produção com `DATA_DIR` fora do código.
3. Executar como serviço (`systemd`), com reinício automático.
4. Nginx como proxy reverso para a porta da aplicação.
5. Certificado HTTPS (Certbot / Let's Encrypt) para o subdomínio escolhido, e `PUBLIC_BASE_URL` com `https://`.
6. Cadastrar o webhook do Mercado Pago apontando para `https://<subdominio>/webhooks/mercadopago`.
