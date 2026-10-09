# side-chat

Um chat lateral dentro da sessão do Claude Code. Faça perguntas sobre o que está acontecendo, ou entregue uma tarefa a um agente, sem interromper a conversa principal, e escolha o modelo de cada um.

## Como usar

| Comando | O que faz |
| --- | --- |
| `/side [mensagem]` | Abre o painel do chat lateral. Com texto, já envia a mensagem. |
| `/side-model <modelo>` | Define o modelo do chat lateral: `haiku`, `sonnet`, `opus`, `fable` ou um ID completo. Sem argumento, mostra o modelo atual. |

O padrão é `haiku` e a sua escolha fica salva entre sessões. Os aliases dependem dos modelos disponíveis na sua conta.

O painel também tem um seletor de modelo, botões com sugestões para começar, **Retry** quando algo falha, **Copy** em cada resposta e **Clear** para limpar o chat lateral.

### Dois modos

- **Ask**: um modelo que leu a conversa principal responde aqui, à parte. Sem ferramentas: nada é alterado.
- **Request**: um agente com ferramentas faz o trabalho nesta sessão e volta com um relatório curto. A conversa principal segue enquanto isso. O agente pode ler e alterar arquivos.

## Instalação

Numa sessão do Claude Code **no terminal** (`claude`), digite:

```text
/plugin install side-chat --marketplace ptpmediabr/side-chat
```

O Claude Code pergunta se pode adicionar o marketplace (responda `y`) e depois o escopo (escolha **user** para valer em todos os projetos). Quando aparecer `Installed side-chat. Plugin is now active.`, o mod já está rodando, sem reiniciar: use `/side`.

O comando de instalação só funciona no terminal. Instalado no escopo *user*, o mod também carrega nas sessões do app desktop do Claude Code. O painel precisa de uma superfície com campo de texto: terminal, app desktop ou VS Code.

## Privacidade: o que é enviado ao modelo

- No modo **Ask**, o mod lê o transcript local da sessão (`~/.claude/projects/<projeto>/<sessão>.jsonl`) e envia ao modelo escolhido o final da conversa, até cerca de 150 mil caracteres: o que você digitou, o que o Claude respondeu e uma marca por ferramenta usada. A saída das ferramentas não vai. Se o transcript não puder ser lido, ele usa as últimas trocas que viu.
- No modo **Request**, o agente recebe até cerca de 20 mil caracteres da conversa e o caminho do transcript, que ele pode ler se precisar de mais.
- Não pede chave de API: as chamadas passam pelo próprio Claude Code, com o mesmo login, e contam no seu uso.
- Guarda no armazenamento local do Claude Code apenas o modelo que você escolheu.

## Desenvolvimento

```bash
claude plugin validate .
claude plugin test .
```

Testado com o Claude Code 2.1.296.

## Licença

[MIT](LICENSE). Feito por Chiara Costa.
