# Publicação do Desapego na VPS (Docker, atrás do Caddy existente)

Destino: `desapego.arrivoinitalia.com` · VPS 179.198.97.88 · Ubuntu 24.04 · rede Docker `arremataflow_default`.
Nada aqui instala Nginx, Caddy ou Certbot, usa as portas 80/443 ou mexe no ArremataFlow.

## 1. Resumo técnico
- Dockerfile de produção: já existe na raiz (`node:22-bookworm-slim`, usuário não root, sem `node_modules` no envio).
- Porta interna do app: **3111**, escutando em `0.0.0.0` (variáveis `PORT` e `HOST`). Nenhuma porta é publicada no host.
- Proxy reverso: o app confia em 1 proxy (`trust proxy`), então funciona atrás do Caddy.
- Volume: `../data` (relativo a `deploy/`) montado em `/app/data`. Contém o banco `desapego-arrivoinitalia.sqlite` e as fotos em `uploads/`.
- Healthcheck: `GET /api/config` (definido no compose).

## 2. Arquivos a alterar ou criar no projeto
| Arquivo | Ação |
|---|---|
| `src/server.js` | alterado: escuta em `process.env.HOST \|\| '0.0.0.0'` |
| `deploy/docker-compose.vps.yml` | novo conteúdo (serviço `desapego`, rede externa `arremataflow_default`, volume, healthcheck, sem portas) |
| `deploy/Caddyfile.desapego` | novo: bloco a acrescentar ao Caddyfile existente |
| `deploy/vps.env.example` | modelo do `.env.vps` |
| `.env.vps` | **criar na VPS** a partir do modelo (não vai no envio e não é sobrescrito se já existir) |

## 3. Variáveis de ambiente (arquivo `.env.vps`, só os nomes)
Obrigatórias: `PUBLIC_BASE_URL` (https://desapego.arrivoinitalia.com), `ADMIN_PASSWORD` (12+ caracteres), `PIX_CHAVE`, `PIX_NOME`, `PIX_CIDADE`, `WHATSAPP_NUMERO`.
Opcionais: `PIX_TITULAR`, `PIX_BANCO` e `PIX_CPF` (aviso "Atenção" do Pix), `RESERVA_HORAS` (48), `MP_MODO_JUROS` (`link`), `LINK_JUROS_6X`, `LINK_TARIFA_PCT`, `LINK_JUROS_PARCELAS`.
Definidas pelo compose (não colocar no `.env.vps`): `PORT=3111`, `HOST=0.0.0.0`, `DATA_DIR=/app/data`.

## 4. Primeiro envio e início
```bash
# na VPS, em /opt/desapego (exemplo), com os arquivos enviados SEM node_modules, data e .env
cd /opt/desapego
[ -f .env.vps ] || cp deploy/vps.env.example .env.vps   # não sobrescreve se já existir
nano .env.vps                                            # preencher os valores
mkdir -p data && chown -R 1000:1000 data                 # o app roda com o usuário 1000
docker compose -f deploy/docker-compose.vps.yml up -d --build
docker compose -f deploy/docker-compose.vps.yml ps       # deve mostrar "healthy"
```

## 5. Caddy
Acrescente o bloco de `deploy/Caddyfile.desapego` ao Caddyfile existente, sem alterar os blocos atuais:
```
desapego.arrivoinitalia.com {
	encode gzip
	reverse_proxy desapego:3111
}
```
Valide e recarregue (troque `NOME_DO_CONTEINER_CADDY`, veja com `docker ps`):
```bash
docker exec NOME_DO_CONTEINER_CADDY caddy validate --config /etc/caddy/Caddyfile
docker exec NOME_DO_CONTEINER_CADDY caddy reload --config /etc/caddy/Caddyfile
```
O Caddy deve estar na rede `arremataflow_default` (já está, pois atende o ArremataFlow).

## 6. Atualizar e reiniciar
```bash
# atualizar: enviar os arquivos novos (sem data e .env.vps) e rodar
docker compose -f deploy/docker-compose.vps.yml up -d --build
# reiniciar
docker compose -f deploy/docker-compose.vps.yml restart desapego
# logs
docker compose -f deploy/docker-compose.vps.yml logs -f desapego
```
`down` e `up` afetam apenas o Desapego.

## 7. Migrar produtos, banco e fotos
No computador de Cleo, a pasta `desapego\data` contém `desapego-arrivoinitalia.sqlite` e `uploads\`.
1. Pare o app local (`docker compose down` na pasta `desapego` do computador) para o banco não estar em uso.
2. Compacte a pasta `data` e envie para a VPS (por exemplo, `scp data.tar.gz usuario@179.198.97.88:/opt/desapego/`).
3. Na VPS:
```bash
cd /opt/desapego
docker compose -f deploy/docker-compose.vps.yml down
[ -d data ] && mv data data.antigo-$(date +%F)   # guarda o que existir
tar -xzf data.tar.gz                              # recria data/
chown -R 1000:1000 data
docker compose -f deploy/docker-compose.vps.yml up -d
```
Alternativa: recadastrar os itens pelo painel `/admin/`.

## 8. Testes de validação
1. `docker compose -f deploy/docker-compose.vps.yml ps` mostra o serviço `healthy`; `docker exec desapego node -e "fetch('http://127.0.0.1:3111/api/config').then(r=>console.log(r.status))"` imprime 200.
2. HTTPS: abrir `https://desapego.arrivoinitalia.com` (cadeado válido, sem aviso) e confirmar que `http://` redireciona para `https://`.
3. Catálogo público: a página inicial lista os itens publicados, com fotos.
4. Painel: `https://desapego.arrivoinitalia.com/admin/` pede a senha; entrar.
5. Produto: criar um item de teste com preço e foto, publicar, editar o preço, confirmar que muda no catálogo e depois despublicar.
6. Pix: abrir o item, "Comprar agora", informar nome e telefone, "Pagar com Pix" e conferir QR code e copia e cola (sem pagar).
7. "Realizar pagamento": cadastrar o link do Mercado Pago no item, clicar em "Pagar com cartão" e depois em "Realizar pagamento"; deve abrir o link cadastrado.
8. Reserva: confirmar que o item reservado fica com o botão de compra bloqueado para outro visitante, e liberar pelo painel.
9. ArremataFlow continua respondendo normalmente.
