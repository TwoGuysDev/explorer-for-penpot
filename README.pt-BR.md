# Explorer for Penpot (português)

Navegue pelos seus designs do [Penpot](https://penpot.app) sem sair do VS Code: times, projetos, arquivos, páginas e boards na barra lateral, e a pré-visualização de qualquer board numa aba.

> **Não oficial.** O Explorer for Penpot é uma extensão da comunidade, feita pela TwoGuysDev. Não é feita, endossada nem suportada pela Penpot ou pela Kaleidos.

## Recursos

- **Barra lateral**: times → projetos → arquivos → páginas → boards, com o tamanho de cada board.
- **Pré-visualização**: clique num board para vê-lo numa aba, desenhado em SVG a partir dos dados do Penpot (layout, textos, imagens, gradientes, bordas, sombras e desfoque). Alterne entre *caber na janela* e *100%*.
- **Comparar com a miniatura do Penpot**: quando o editor do Penpot já gerou a miniatura do board, ela aparece ao lado.
- **Abrir arquivos `.penpot`**: clique num `.penpot` exportado que esteja no seu workspace (por exemplo, um que fica no repositório junto do código) para navegar pelas páginas e boards e vê-los desenhados, com as imagens que vêm dentro do arquivo. Não precisa de conexão nem de token, e a visualização se atualiza quando o arquivo muda. A seção **Arquivos do workspace**, na barra lateral do Penpot, mostra todos os `.penpot` do workspace em árvore (arquivo → páginas → boards); clique num board para abri-lo.
- **Editar com IA (MCP)**: um servidor MCP local deixa assistentes de IA como o Claude Code lerem e editarem os arquivos `.penpot` do workspace, sem navegador e sem servidor do Penpot. Veja [Editar designs com IA](#editar-designs-com-ia-mcp).
- **Abrir no Penpot**: vai de um arquivo, página ou board direto para o editor do Penpot no navegador.
- **Penpot Cloud e self-hosted**: funciona com o `design.penpot.app` e com o seu Penpot próprio (inclusive `localhost`).
- **Inglês e português do Brasil.**

## Como começar

1. Instale a extensão e clique no ícone **Penpot** na barra de atividades.
2. Clique em **Conectar ao Penpot** e escolha **Penpot Cloud** ou digite o endereço do seu Penpot.
3. Crie um access token no Penpot: **Sua conta → Integrations → Access tokens → Generate new token** e cole.

O token é conferido no Penpot antes de ser salvo.

### Penpot próprio (self-hosted)

Os access tokens precisam estar ligados. Acrescente `enable-access-tokens` ao `PENPOT_FLAGS` (frontend e backend) e reinicie o Penpot. No Docker oficial, é a linha `x-flags` do `docker-compose.yaml`.

## Editar designs com IA (MCP)

A extensão pode rodar um servidor [MCP](https://modelcontextprotocol.io) para que um assistente de IA edite seus designs direto nos arquivos `.penpot` do workspace. Não precisa de mais nada aberto: nem aba do navegador, nem app do Penpot, nem Docker.

1. Rode **Penpot: Iniciar servidor MCP** (ou ligue `penpotExplorer.mcp.enabled`). Aparece o item **Penpot MCP** na barra de status.
2. Rode **Penpot: Copiar configuração do MCP para o Claude Code** e cole o comando num terminal:
   ```sh
   claude mcp add --transport http penpot-explorer http://127.0.0.1:4410/mcp
   ```
   Outros clientes MCP usam o mesmo endereço (Streamable HTTP).
3. Peça as mudanças, por exemplo *"no home.penpot, deixe o título do topo com 40px e coloque um botão Cadastrar embaixo"*.

Ferramentas: `list_designs`, `get_structure`, `get_layers`, `get_shapes`, `edit` (cria boards, formas, textos e ícones SVG; altera, move, duplica e apaga num lote só, salvo de uma vez) e `screenshot` (PNG de um board, mostrado também numa aba **Penpot MCP**).

- **Layouts flex ficam como no Penpot**: depois de cada edição o servidor posiciona os filhos dos boards com flex (direção, gap, padding, justify, align, wrap, tamanhos fill/auto, margens, mín./máx.). Boards com grid mantêm os filhos onde estão.
- **O tamanho dos textos é estimado** até o arquivo ser aberto no Penpot, que mede com as fontes de verdade.
- **Componentes**: mudanças dentro de cópias viram overrides; principais não podem ser apagados pelo MCP.
- Boards editados perdem a miniatura guardada no export; o Penpot gera outra quando você importa o arquivo.
- Para continuar no Penpot, importe o `.penpot` (**Projetos → Importar**). Os arquivos da sua conta do Penpot aparecem só para leitura por enquanto: exporte como `.penpot` para o workspace para editá-los.

## Privacidade e segurança

- O token fica no **cofre de segredos** do VS Code (o gerenciador de credenciais do sistema), nunca em configurações ou arquivos.
- Os arquivos `.penpot` são lidos localmente e não são enviados a lugar nenhum.
- A extensão só fala com o servidor Penpot que você configurou, pela API pública do Penpot, com o seu token. Ela nunca altera os designs da sua conta do Penpot.
- O servidor MCP vem **desligado**. Ligado, ele só escuta em `127.0.0.1`, recusa pedidos vindos de páginas web e só lê e grava arquivos `.penpot` que estão no workspace.
- **Sem telemetria.** A extensão não coleta nada.
- Por padrão, a pré-visualização carrega as fontes Inter e JetBrains Mono do Google Fonts para os textos ficarem mais perto do Penpot. Desligue `penpotExplorer.preview.loadWebFonts` para evitar esse acesso.

## Limitações

- A pré-visualização é uma aproximação desenhada pela extensão, não o renderizador do próprio Penpot. Alguns detalhes mudam (métricas de texto com fontes que você não tem instaladas, máscaras e alguns modos de mesclagem). Use **Miniatura** para comparar ou **Abrir no Penpot**.
- Arquivos `.penpot` do Penpot 1.x (o formato binário antigo) não abrem: importe no Penpot 2.x e exporte de novo.
- A edição é só pelo servidor MCP e só em arquivos `.penpot` do workspace. Arquivos da sua conta do Penpot ainda não podem ser editados.

Licença [MIT](LICENSE) © TwoGuysDev. Penpot é marca dos seus donos e aparece aqui só para dizer com o que a extensão funciona.
