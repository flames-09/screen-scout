import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * Safe Markdown rendering: react-markdown without `rehype-raw` never passes
 * raw HTML through — model output can't execute scripts or inject markup.
 * Links are intercepted and opened only after the user confirms in a dialog
 * (the main process validates http/https again).
 */
export const MarkdownView = memo(function MarkdownView({ content }: { content: string }): JSX.Element {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const url = typeof href === 'string' ? href : ''
            return (
              <a
                href={url}
                title="Opens in your browser after confirmation"
                onClick={(e) => {
                  e.preventDefault()
                  if (url) void window.scout.app.openExternal(url)
                }}
              >
                {children}
              </a>
            )
          },
          pre: ({ children }) => <pre className="code-block">{children}</pre>,
          code: ({ className, children, ...props }) => {
            const isBlock = typeof className === 'string' && className.includes('language-')
            if (isBlock) {
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              )
            }
            return (
              <code className="inline-code" {...props}>
                {children}
              </code>
            )
          }
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
})
