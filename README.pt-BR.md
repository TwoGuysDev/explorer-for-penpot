# Explorer for Penpot (português)

Navegue pelos seus designs do [Penpot](https://penpot.app) sem sair do VS Code: times, projetos, arquivos, páginas e boards na barra lateral, e a pré-visualização de qualquer board numa aba.

> **Não oficial.** O Explorer for Penpot é uma extensão da comunidade, feita pela TwoGuysDev. Não é feita, endossada nem suportada pela Penpot ou pela Kaleidos.

## Recursos

- **Barra lateral**: times → projetos → arquivos → páginas → boards, com o tamanho de cada board.
- **Pré-visualização**: clique num board para vê-lo numa aba, desenhado em SVG a partir dos dados do Penpot (layout, textos, imagens, gradientes, bordas, sombras e desfoque). Alterne entre *caber na janela* e *100%*.
- **Comparar com a miniatura do Penpot**: quando o editor do Penpot já gerou a miniatura do board, ela aparece ao lado.
- **Abrir arquivos `.penpot`**: clique num `.penpot` exportado que esteja no seu workspace (por exemplo, um que fica no repositório junto do código) para navegar pelas páginas e boards e vê-los desenhados, com as imagens que vêm dentro do arquivo. Não precisa de conexão nem de token, e a visualização se atualiza quando o arquivo muda.
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

## Privacidade e segurança

- O token fica no **cofre de segredos** do VS Code (o gerenciador de credenciais do sistema), nunca em configurações ou arquivos.
- Os arquivos `.penpot` são lidos localmente e não são enviados a lugar nenhum.
- A extensão só fala com o servidor Penpot que você configurou, pela API pública do Penpot, com o seu token. Ela **só lê**: nunca altera seus designs.
- **Sem telemetria.** A extensão não coleta nada.
- Por padrão, a pré-visualização carrega as fontes Inter e JetBrains Mono do Google Fonts para os textos ficarem mais perto do Penpot. Desligue `penpotExplorer.preview.loadWebFonts` para evitar esse acesso.

## Limitações

- A pré-visualização é uma aproximação desenhada pela extensão, não o renderizador do próprio Penpot. Alguns detalhes mudam (métricas de texto com fontes que você não tem instaladas, máscaras e alguns modos de mesclagem). Use **Miniatura** para comparar ou **Abrir no Penpot**.
- Arquivos `.penpot` do Penpot 1.x (o formato binário antigo) não abrem: importe no Penpot 2.x e exporte de novo.
- Não edita: é para navegar e visualizar.

Licença [MIT](LICENSE) © TwoGuysDev. Penpot é marca dos seus donos e aparece aqui só para dizer com o que a extensão funciona.
